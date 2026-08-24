import type { Registry } from "./registry.ts";
import type { SourceOutcome } from "./report.ts";
import type { SourceResult } from "./sources/types.ts";

export type UpdateStep = (registry: Registry) => { registry: Registry; result: SourceResult };

export interface UpdateSource {
  name: string;
  disabled: string | null;
  fetch: (registry: Registry) => Promise<{ discover: UpdateStep; apply: UpdateStep }>;
}

export interface PipelineResult {
  registry: Registry;
  outcomes: SourceOutcome[];
  failed: boolean;
  fetchedSources: string[];
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Run independent fetches, then discovery and vendor-first application with source-level isolation. */
export async function runUpdatePipeline(initial: Registry, sources: readonly UpdateSource[]): Promise<PipelineResult> {
  let registry = initial;
  const states = new Map<string, SourceOutcome>();
  const fetched = await Promise.all(sources.map(async (source) => {
    if (source.disabled !== null) {
      states.set(source.name, { kind: "skipped", source: source.name, reason: source.disabled });
      return null;
    }
    try {
      return { source, ...await source.fetch(initial) };
    } catch (error) {
      states.set(source.name, { kind: "failed", source: source.name, error: message(error) });
      return null;
    }
  }));
  const ready = fetched.filter((entry) => entry !== null);
  const active = new Map(ready.map((entry) => [entry.source.name, entry]));
  const merged = new Map<string, SourceResult>();

  const run = (step: UpdateStep, name: string): void => {
    const next = step(registry);
    registry = next.registry;
    const sofar = merged.get(name) ?? { source: name, changes: [], notes: [] };
    merged.set(name, {
      source: name,
      changes: [...sofar.changes, ...next.result.changes],
      notes: [...sofar.notes, ...next.result.notes],
    });
  };
  for (const entry of ready) {
    try {
      run(entry.discover, entry.source.name);
    } catch (error) {
      states.set(entry.source.name, { kind: "failed", source: entry.source.name, error: `discover: ${message(error)}` });
      active.delete(entry.source.name);
    }
  }
  const applyOrder = [...active.values()].sort(
    (left, right) => Number(left.source.name === "OpenRouter") - Number(right.source.name === "OpenRouter"),
  );
  for (const entry of applyOrder) {
    try {
      run(entry.apply, entry.source.name);
      states.set(entry.source.name, {
        kind: "applied",
        result: merged.get(entry.source.name) ?? { source: entry.source.name, changes: [], notes: [] },
      });
    } catch (error) {
      states.set(entry.source.name, { kind: "failed", source: entry.source.name, error: `apply: ${message(error)}` });
    }
  }

  // Every source lands in `states` — skipped, failed, or applied. A gap would
  // mean a name collision in `sources`, and an undefined outcome would only
  // surface as a crash inside the report; say so here instead.
  const outcomes = sources.map((source) => {
    const outcome = states.get(source.name);
    if (outcome === undefined) {
      throw new Error(`update source "${source.name}" produced no outcome — are two sources named alike?`);
    }
    return outcome;
  });
  return {
    registry,
    outcomes,
    failed: outcomes.some((outcome) => outcome.kind === "failed"),
    fetchedSources: ready.map((entry) => entry.source.name),
  };
}
