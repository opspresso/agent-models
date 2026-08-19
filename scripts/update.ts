/**
 * Bring the source files up to date with what the providers publish, then
 * report what moved.
 *
 *   node scripts/update.ts            # apply, write models/**, print the report
 *   node scripts/update.ts --dry-run  # report only
 *
 * Sources run independently. OpenRouter needs no key and always runs; xAI,
 * Anthropic and OpenAI run when their key is in the environment and are
 * reported as skipped otherwise. One source failing does not stop the others —
 * what they found is still written — but the exit code is 1, so the run shows
 * red and nobody reads a quiet summary as a clean one.
 *
 * Nothing is written if the patched registry fails validation: a provider
 * publishing a max output above its own window is a thing to look at, not a
 * thing to publish.
 */

import { appendFileSync } from "node:fs";
import { loadRegistry, validateRegistry, writeRegistry, type Registry } from "../src/registry.ts";
import { renderReport, type SourceOutcome } from "../src/report.ts";
import { applyAnthropic, fetchAnthropicModels } from "../src/sources/anthropic.ts";
import { applyOpenAi, fetchOpenAiModelIds } from "../src/sources/openai.ts";
import { applyOpenRouter, fetchOpenRouterCatalog } from "../src/sources/openrouter.ts";
import { utcDate } from "../src/sources/presence.ts";
import { applyXai, fetchXaiCatalog } from "../src/sources/xai.ts";
import type { SourceResult } from "../src/sources/types.ts";
import { ROOT } from "./_root.ts";

const dryRun = process.argv.includes("--dry-run");
/** The job's clock: one UTC date for the whole run, so every source agrees on what "today" is. */
const today = utcDate(new Date());

interface Source {
  name: string;
  /** Why the source cannot run, or null when it can. */
  disabled: string | null;
  run: (registry: Registry) => Promise<{ registry: Registry; result: SourceResult }>;
}

function keyed(name: string): string | null {
  return process.env[name] ? null : `\`${name}\` is not set`;
}

const SOURCES: Source[] = [
  {
    name: "OpenRouter",
    disabled: null,
    run: async (registry) => {
      const routes = registry.offerings
        .filter((o) => o.provider === "openrouter" && !o.hidden && o.wireId !== undefined)
        .map((o) => o.wireId as string);
      return applyOpenRouter(registry, await fetchOpenRouterCatalog(routes), today);
    },
  },
  {
    name: "xAI",
    disabled: keyed("XAI_API_KEY"),
    run: async (registry) => applyXai(registry, await fetchXaiCatalog(process.env.XAI_API_KEY as string), today),
  },
  {
    name: "Anthropic",
    disabled: keyed("ANTHROPIC_API_KEY"),
    run: async (registry) =>
      applyAnthropic(registry, await fetchAnthropicModels(process.env.ANTHROPIC_API_KEY as string), today),
  },
  {
    name: "OpenAI",
    disabled: keyed("OPENAI_API_KEY"),
    run: async (registry) =>
      applyOpenAi(registry, await fetchOpenAiModelIds(process.env.OPENAI_API_KEY as string), today),
  },
];

let registry = loadRegistry(ROOT);
const before = validateRegistry(registry);
if (before.length > 0) {
  console.error(`registry is invalid before the update:\n  - ${before.join("\n  - ")}`);
  process.exit(1);
}

const outcomes: SourceOutcome[] = [];
let failed = false;
for (const source of SOURCES) {
  if (source.disabled !== null) {
    outcomes.push({ kind: "skipped", source: source.name, reason: source.disabled });
    continue;
  }
  try {
    const applied = await source.run(registry);
    registry = applied.registry;
    outcomes.push({ kind: "applied", result: applied.result });
  } catch (error) {
    failed = true;
    outcomes.push({
      kind: "failed",
      source: source.name,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

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
  console.log("\nwrote models/");
}

process.exit(failed ? 1 : 0);
