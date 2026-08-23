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
import { loadRemovalManifest } from "../src/removals.ts";
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
        throw new Error("complete weekly rankings and usable Top 20 image endpoints are required for an OpenRouter reset");
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

let registry = loadRegistry(ROOT);
loadRemovalManifest(ROOT);
const baseline = structuredClone(registry);
const before = validateRegistry(registry);
if (before.length > 0) {
  console.error(`registry is invalid before the update:\n  - ${before.join("\n  - ")}`);
  process.exit(1);
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
const outcomes: SourceOutcome[] = pipeline.outcomes;
let failed = pipeline.failed;
if (resetOpenRouter && !pipeline.fetchedSources.includes("OpenRouter")) {
  console.error("\nOpenRouter reset aborted; the existing registry was not changed");
  process.exit(1);
}

const after = validateRegistry(registry);
if (after.length > 0) {
  console.error(`\nthe update would leave the registry invalid; nothing written:\n  - ${after.join("\n  - ")}`);
  process.exit(1);
}

const anomalies = detectRegistryAnomalies(baseline, registry, { allowPolicyBootstrap: resetOpenRouter });
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
const report = renderReport(outcomes, today);
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
}
if (unapprovedAnomalies || processingFailure) {
  if (!dryRun) writeTextAtomic(REPORT_PATH, `${JSON.stringify({ date: today, outcomes }, null, 2)}\n`);
  console.error("\nupdate quarantined because a safety check or processing step failed; models/ was not changed");
  process.exit(1);
}

if (dryRun) {
  console.log("\n(dry run — nothing written)");
} else {
  writeRegistry(ROOT, registry);
  writeTextAtomic(REPORT_PATH, `${JSON.stringify({ date: today, outcomes }, null, 2)}\n`);
  console.log("\nwrote models/ and update-report.json");
}

process.exit(failed ? 1 : 0);
