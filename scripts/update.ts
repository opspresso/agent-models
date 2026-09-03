/**
 * Bring the source files up to date with what the providers publish, then
 * report what moved.
 *
 *   node scripts/update.ts            # apply, write models/**, print the report
 *   node scripts/update.ts --dry-run  # report only
 *   node scripts/update.ts --reset-openrouter # rebuild OpenRouter from the full eligible catalog
 *
 * Three phases, so every source sees the same registry:
 *
 *   1. fetch     — every source reads its catalog; one failing does not stop
 *                  the others, and is reported as failed.
 *   2. discover  — what the catalogs list that the registry does not: new
 *                  families (OpenRouter) and new routes (every source).
 *   3. apply     — numbers, discounts, presence and retirement for every route
 *                  the registry now has, the ones just added included.
 *
 * OpenRouter needs no key and always runs; xAI, Anthropic, OpenAI and Google
 * run when their key is in the environment and are reported as skipped
 * otherwise. The exit code is 1 when a source failed, so the run shows red and
 * nobody reads a quiet summary as a clean one — what the other sources found
 * is still written.
 *
 * Nothing is written if the patched registry fails validation: a provider
 * publishing a max output above its own window is a thing to look at, not a
 * thing to publish.
 *
 * Besides the Markdown report (stdout and the job summary) the run leaves
 * `update-report.json` for `scripts/notify.ts`, which runs after the update attempt.
 */

import { appendFileSync } from "node:fs";
import { loadRegistry, validateRegistry, writeRegistry, writeTextAtomic } from "../src/registry.ts";
import { renderReport, type SourceOutcome } from "../src/report.ts";
import { anomalyDigest, detectRegistryAnomalies } from "../src/safety.ts";
import { findRemovalCandidates, loadRemovalManifest, type RemovalCandidate } from "../src/removals.ts";
import { runUpdatePipeline, type UpdateSource } from "../src/update-pipeline.ts";
import { applyAnthropic, discoverAnthropic, fetchAnthropicModels } from "../src/sources/anthropic.ts";
import { applyGoogle, discoverGoogle, fetchGoogleModels } from "../src/sources/google.ts";
import { applyOpenAi, discoverOpenAi, fetchOpenAiModelIds } from "../src/sources/openai.ts";
import {
  applyOpenRouter,
  discoverOpenRouter,
  discoveryEndpointIds,
  fetchOpenRouterCatalog,
  openRouterResetReady,
  resetOpenRouterRegistry,
} from "../src/sources/openrouter.ts";
import { utcDate } from "../src/sources/presence.ts";
import { applyXai, discoverXai, fetchXaiCatalog } from "../src/sources/xai.ts";
import { REPORT_PATH, ROOT } from "./_root.ts";

const dryRun = process.argv.includes("--dry-run");
const resetOpenRouter = process.argv.includes("--reset-openrouter");
const anomalyApproval = process.argv
  .find((argument) => argument.startsWith("--approve-anomaly="))
  ?.slice("--approve-anomaly=".length);
/** The job's clock: one UTC date for the whole run, so every source agrees on what "today" is. */
const today = utcDate(new Date());

function keyed(name: string): string | null {
  return process.env[name] ? null : `\`${name}\` is not set`;
}

const SOURCES: UpdateSource[] = [
  {
    name: "OpenRouter",
    disabled: null,
    fetch: async (registry) => {
      const routes = registry.offerings
        .filter((o) => o.provider === "openrouter" && !o.hidden && o.wireId !== undefined)
        .map((o) => o.wireId as string);
      const catalog = await fetchOpenRouterCatalog((models, rankings) => [
        ...routes,
        ...discoveryEndpointIds(registry, models, today, rankings, { bootstrap: resetOpenRouter }),
      ]);
      if (resetOpenRouter && !openRouterResetReady(catalog)) {
        throw new Error("complete text/image/embedding/rerank/transcription weekly rankings and usable Top 20 image endpoints are required for an OpenRouter reset");
      }
      return {
        discover: (r) => discoverOpenRouter(r, catalog, today, { bootstrap: resetOpenRouter }),
        apply: (r) => applyOpenRouter(r, catalog, today),
      };
    },
  },
  {
    name: "xAI",
    disabled: keyed("XAI_API_KEY"),
    fetch: async () => {
      const catalog = await fetchXaiCatalog(process.env.XAI_API_KEY as string);
      return { discover: (r) => discoverXai(r, catalog), apply: (r) => applyXai(r, catalog, today) };
    },
  },
  {
    name: "Anthropic",
    disabled: keyed("ANTHROPIC_API_KEY"),
    fetch: async () => {
      const catalog = await fetchAnthropicModels(process.env.ANTHROPIC_API_KEY as string);
      return { discover: (r) => discoverAnthropic(r, catalog), apply: (r) => applyAnthropic(r, catalog, today) };
    },
  },
  {
    name: "OpenAI",
    disabled: keyed("OPENAI_API_KEY"),
    fetch: async () => {
      const ids = await fetchOpenAiModelIds(process.env.OPENAI_API_KEY as string);
      return { discover: (r) => discoverOpenAi(r, ids), apply: (r) => applyOpenAi(r, ids, today) };
    },
  },
  {
    name: "Google",
    disabled: keyed("GOOGLE_API_KEY"),
    fetch: async () => {
      const catalog = await fetchGoogleModels(process.env.GOOGLE_API_KEY as string);
      return { discover: (r) => discoverGoogle(r, catalog), apply: (r) => applyGoogle(r, catalog, today) };
    },
  },
];

const outcomes: SourceOutcome[] = [];

/**
 * Render the report, leave it for `notify.ts`, and stop. Every exit comes
 * through here, a refusal to write included: a run that gave up still has to
 * say why on the channels people watch, or a hard failure reaches nobody but
 * the job log.
 *
 * `removalCandidates` is empty unless `models/` was actually written —
 * `propose-removals` resolves them against the registry *on disk*, so a
 * quarantined run must not hand it candidates that only ever existed in
 * memory.
 */
function finish(code: number, removalCandidates: RemovalCandidate[] = []): never {
  const report = renderReport(outcomes, today);
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
  }
  if (!dryRun) {
    writeTextAtomic(REPORT_PATH, `${JSON.stringify({ date: today, outcomes, removalCandidates }, null, 2)}\n`);
  }
  process.exit(code);
}

/** Stop on a failure that is the run's own, not a source's. */
function abort(source: string, error: string): never {
  console.error(error);
  outcomes.push({ kind: "failed", source, error });
  finish(1);
}

let registry = loadRegistry(ROOT);
const removalRequests = loadRemovalManifest(ROOT);
const baseline = structuredClone(registry);
const before = validateRegistry(registry);
if (before.length > 0) {
  abort("Registry", `registry is invalid before the update:\n  - ${before.join("\n  - ")}`);
}
if (resetOpenRouter) {
  const reset = resetOpenRouterRegistry(registry);
  registry = reset.registry;
  console.log(
    `reset OpenRouter in memory: preserved and deactivated ${reset.deactivatedOfferings} offerings`,
  );
}

const pipeline = await runUpdatePipeline(registry, SOURCES);
registry = pipeline.registry;
outcomes.push(...pipeline.outcomes);
let failed = pipeline.failed;
if (resetOpenRouter && !pipeline.fetchedSources.includes("OpenRouter")) {
  abort("OpenRouter reset", "OpenRouter reset aborted; the existing registry was not changed");
}

const after = validateRegistry(registry);
if (after.length > 0) {
  abort("Registry", `the update would leave the registry invalid; nothing written:\n  - ${after.join("\n  - ")}`);
}
const removalCandidates = findRemovalCandidates(registry, removalRequests, today);

const anomalies = detectRegistryAnomalies(baseline, registry);
const digest = anomalies.length > 0 ? anomalyDigest(anomalies) : null;
const unapprovedAnomalies = digest !== null && anomalyApproval !== digest;
const processingFailure = outcomes.some(
  (outcome) => outcome.kind === "failed" && /^(discover|apply):/.test(outcome.error),
);
if (unapprovedAnomalies) {
  failed = true;
  outcomes.push({
    kind: "failed",
    source: "Safety gate",
    error: `${anomalies.join("\n")}\nreview the diff, then rerun with --approve-anomaly=${digest}`,
  });
} else if (digest !== null) {
  outcomes.push({
    kind: "applied",
    result: {
      source: "Safety gate",
      changes: [{ target: `anomaly set ${digest}`, field: "approved", from: false, to: true }],
      notes: [],
    },
  });
}
if (unapprovedAnomalies || processingFailure) {
  console.error("\nupdate quarantined because a safety check or processing step failed; models/ was not changed");
  finish(1);
}

if (dryRun) {
  console.log("\n(dry run — nothing written)");
  finish(failed ? 1 : 0);
}
writeRegistry(ROOT, registry);
console.log("\nwrote models/ and update-report.json");
finish(failed ? 1 : 0, removalCandidates);
