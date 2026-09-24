import type { Registry } from "./registry.ts";
import type { SourceOutcome } from "./report.ts";
import { HttpError, type SourceResult } from "./sources/types.ts";

export type UpdateStep = (registry: Registry) => { registry: Registry; result: SourceResult };

export interface UpdateSource {
  name: string;
  disabled: string | null;
  /** A vendor catalog's optional API key; authentication failures skip only this source. */
  credentialName?: string;
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

function credentialFailure(source: UpdateSource, error: unknown): error is HttpError {
  return source.credentialName !== undefined
    && error instanceof HttpError
    && (error.status === 401 || error.status === 403 || source.credentialName === "GOOGLE_API_KEY" && error.status === 400 && error.reason === "API_KEY_INVALID");
}

/** Run independent fetches, then discovery and vendor-first application with source-level isolation. */
export async function runUpdatePipeline(initial: Registry, sources: readonly UpdateSource[]): Promise<PipelineResult> {
  const names = new Set<string>();
  for (const source of sources) {
    if (names.has(source.name)) throw new Error(`duplicate update source "${source.name}"`);
    names.add(source.name);
  }
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
      if (credentialFailure(source, error)) {
        states.set(source.name, {
          kind: "skipped",
          source: source.name,
          reason: `\`${source.credentialName}\` was rejected (HTTP ${error.status}); check the key and its permissions`,
        });
      } else {
        states.set(source.name, { kind: "failed", source: source.name, error: message(error) });
      }
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

  // Every source lands in `states` — skipped, failed, or applied. A missing
  // outcome is an internal pipeline error, not an empty report row.
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
