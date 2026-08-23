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
 * `update-report.json` for `scripts/notify.ts`, which runs after the commit.
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { loadRegistry, validateRegistry, writeRegistry, type Registry } from "../src/registry.ts";
import { renderReport, type SourceOutcome } from "../src/report.ts";
import { applyAnthropic, discoverAnthropic, fetchAnthropicModels } from "../src/sources/anthropic.ts";
import { applyGoogle, discoverGoogle, fetchGoogleModels } from "../src/sources/google.ts";
import { applyOpenAi, discoverOpenAi, fetchOpenAiModelIds } from "../src/sources/openai.ts";
import {
  applyOpenRouter,
  discoverOpenRouter,
  discoveryEndpointIds,
  fetchOpenRouterCatalog,
  resetOpenRouterRegistry,
} from "../src/sources/openrouter.ts";
import { utcDate } from "../src/sources/presence.ts";
import { applyXai, discoverXai, fetchXaiCatalog } from "../src/sources/xai.ts";
import type { SourceResult } from "../src/sources/types.ts";
import { REPORT_PATH, ROOT } from "./_root.ts";

const dryRun = process.argv.includes("--dry-run");
const resetOpenRouter = process.argv.includes("--reset-openrouter");
/** The job's clock: one UTC date for the whole run, so every source agrees on what "today" is. */
const today = utcDate(new Date());

type Step = (registry: Registry) => { registry: Registry; result: SourceResult };

interface Source {
  name: string;
  /** Why the source cannot run, or null when it can. */
  disabled: string | null;
  /** Read the catalog once; answer the discover and apply steps bound to it. */
  fetch: (registry: Registry) => Promise<{ discover: Step; apply: Step }>;
}

function keyed(name: string): string | null {
  return process.env[name] ? null : `\`${name}\` is not set`;
}

const SOURCES: Source[] = [
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
      if (resetOpenRouter && (catalog.rankings === null || catalog.imageRankings === null)) {
        throw new Error("weekly text and image rankings are required for an OpenRouter reset");
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
const before = validateRegistry(registry);
if (before.length > 0) {
  console.error(`registry is invalid before the update:\n  - ${before.join("\n  - ")}`);
  process.exit(1);
}
if (resetOpenRouter) {
  const reset = resetOpenRouterRegistry(registry);
  registry = reset.registry;
  console.log(
    `reset OpenRouter in memory: removed ${reset.removedOfferings} offerings and ${reset.removedFamilies} orphaned families`,
  );
}

// Phase 1 — fetch.
const outcomes: SourceOutcome[] = [];
const ready: Array<{ source: Source; discover: Step; apply: Step }> = [];
let failed = false;
for (const source of SOURCES) {
  if (source.disabled !== null) {
    outcomes.push({ kind: "skipped", source: source.name, reason: source.disabled });
    continue;
  }
  try {
    const steps = await source.fetch(registry);
    ready.push({ source, ...steps });
  } catch (error) {
    failed = true;
    outcomes.push({
      kind: "failed",
      source: source.name,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
if (resetOpenRouter && !ready.some(({ source }) => source.name === "OpenRouter")) {
  console.error("\nOpenRouter reset aborted; the existing registry was not changed");
  process.exit(1);
}

// Phase 2 — discover, phase 3 — apply; one merged result per source.
const merged = new Map<string, SourceResult>();
function run(step: Step, name: string): void {
  const { registry: next, result } = step(registry);
  registry = next;
  const sofar = merged.get(name) ?? { source: name, changes: [], notes: [] };
  merged.set(name, {
    source: name,
    changes: [...sofar.changes, ...result.changes],
    notes: [...sofar.notes, ...result.notes],
  });
}
for (const { source, discover } of ready) run(discover, source.name);
// Vendors first, the router last: applyOpenRouter compares its listing to the
// family's list price, and on the day a vendor moves that price the comparison
// must see today's number — router-first left a one-day discount flap that
// self-corrected the next run, as diff noise.
const applyOrder = [...ready].sort(
  (a, b) => Number(a.source.name === "OpenRouter") - Number(b.source.name === "OpenRouter"),
);
for (const { source, apply } of applyOrder) run(apply, source.name);
for (const { source } of ready) {
  outcomes.push({ kind: "applied", result: merged.get(source.name) as SourceResult });
}
// The report in source order, whatever order the outcomes were pushed in.
const order = (outcome: SourceOutcome): number =>
  SOURCES.findIndex((s) => s.name === (outcome.kind === "applied" ? outcome.result.source : outcome.source));
outcomes.sort((a, b) => order(a) - order(b));

const report = renderReport(outcomes, today);
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
}

const after = validateRegistry(registry);
if (after.length > 0) {
  console.error(`\nthe update would leave the registry invalid; nothing written:\n  - ${after.join("\n  - ")}`);
  process.exit(1);
}

if (dryRun) {
  console.log("\n(dry run — nothing written)");
} else {
  writeRegistry(ROOT, registry);
  writeFileSync(REPORT_PATH, `${JSON.stringify({ date: today, outcomes }, null, 2)}\n`);
  console.log("\nwrote models/ and update-report.json");
}

process.exit(failed ? 1 : 0);
