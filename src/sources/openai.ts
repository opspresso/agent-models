/**
 * OpenAI's `GET /v1/models` lists ids and nothing else — no price, no window
 * — so this source moves no number. It exists to notice when a registered
 * model is no longer served, which is the one thing about OpenAI's catalog
 * that goes stale silently; the retirement itself follows `presence.ts`.
 */

import type { Registry } from "../registry.ts";
import { observePresence, offeringNames } from "./presence.ts";
import { addRoute, familyHasRoute, familyIsLive } from "./routes.ts";
import { catalogNames, fetchJson, isExternalId, type Change, type SourceResult } from "./types.ts";

export const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";

export async function fetchOpenAiModelIds(apiKey: string, fetchFn: typeof fetch = fetch): Promise<string[]> {
  const body = (await fetchJson(
    OPENAI_MODELS_URL,
    { headers: { Authorization: `Bearer ${apiKey}` } },
    fetchFn,
  )) as { data?: unknown };
  if (!Array.isArray(body.data)) {
    throw new Error(`GET ${OPENAI_MODELS_URL} → no "data" array`);
  }
  if (!body.data.every((entry) => typeof entry === "object" && entry !== null && isExternalId((entry as { id?: unknown }).id))) {
    throw new Error(`GET ${OPENAI_MODELS_URL} → invalid entry (shape drift?)`);
  }
  const ids = body.data.map((entry) => (entry as { id: string }).id);
  if (ids.length === 0) {
    throw new Error(`GET ${OPENAI_MODELS_URL} → empty catalog`);
  }
  return ids;
}

export function applyOpenAi(
  registry: Registry,
  ids: string[],
  today: string,
): { registry: Registry; result: SourceResult } {
  const next = structuredClone(registry);
  // A provider that lists only dated snapshots still serves the undated alias
  // (Anthropic does exactly this), and agent-studio's check-models credits
  // both date forms — without the same folding here the two tools hand down
  // different verdicts on the same catalog.
  const served = catalogNames(ids);
  const changes: Change[] = [];
  const notes: string[] = [];
  for (const offering of next.offerings) {
    if (offering.provider !== "openai" || (offering.hidden && offering.hiddenReason !== "catalog")) {
      continue;
    }
    observePresence(offering, offeringNames(offering).some((name) => served.has(name)), "OpenAI", today, changes, notes);
  }
  return { registry: next, result: { source: "OpenAI", changes, notes } };
}

/**
 * An `openai/` route for every live OpenAI-made non-image family the
 * catalog serves under the family's own id and this registry does not yet
 * route there. Dated snapshots fold to their alias exactly as they do for presence: a route the
 * retirement clock counts as alive is one discovery must be willing to add.
 * The family's price is then the list price (`promoteFamily`), which is what
 * OpenAI charges and what OpenRouter's listing was discounting from.
 */
export function discoverOpenAi(registry: Registry, ids: string[]): { registry: Registry; result: SourceResult } {
  const next = structuredClone(registry);
  const changes: Change[] = [];
  const served = catalogNames(ids);
  for (const [id, family] of Object.entries(next.families)) {
    if (family.maker !== "openai" || family.capabilities.imageGeneration) {
      continue;
    }
    if (familyHasRoute(next, id, "openai") || !familyIsLive(next, id) || !served.has(id)) {
      continue;
    }
    addRoute(next, { provider: "openai", family: id }, changes);
  }
  return { registry: next, result: { source: "OpenAI", changes, notes: [] } };
}
