/**
 * Anthropic's `GET /v1/models` reports `max_input_tokens` and `max_tokens`
 * per model, which are the family's window and output cap — prefer it over
 * the docs table when they disagree. It carries no price, so pricing stays
 * hand-kept against the pricing page.
 *
 * Ids are matched through the offering's `wireId` (Anthropic hyphenates what
 * the registry dots), and a dated snapshot stands for its undated alias:
 * `claude-haiku-4-5-20251001` is the catalog's spelling of `claude-haiku-4-5`.
 */

import type { Registry } from "../registry.ts";
import { observePresence } from "./presence.ts";
import { addRoute, familyHasRoute, familyIsLive } from "./routes.ts";
import { fetchJson, isPositiveInt, type Change, type SourceResult } from "./types.ts";

export const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models";
const ANTHROPIC_VERSION = "2023-06-01";
/** Far more pages than any catalog needs; a runaway `has_more` must not spin. */
const MAX_PAGES = 25;

export interface AnthropicModel {
  id: string;
  max_input_tokens?: number;
  max_tokens?: number;
}

export async function fetchAnthropicModels(
  apiKey: string,
  fetchFn: typeof fetch = fetch,
): Promise<AnthropicModel[]> {
  const headers = { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION };
  const collected: AnthropicModel[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = `${ANTHROPIC_MODELS_URL}?limit=100${cursor ? `&after_id=${encodeURIComponent(cursor)}` : ""}`;
    const body = (await fetchJson(url, { headers }, fetchFn)) as {
      data?: unknown;
      has_more?: unknown;
      last_id?: unknown;
    };
    if (!Array.isArray(body.data)) {
      throw new Error(`GET ${url} → no "data" array`);
    }
    collected.push(...(body.data as AnthropicModel[]));
    if (body.has_more !== true || typeof body.last_id !== "string" || body.last_id === "") {
      if (collected.length === 0) {
        throw new Error(`GET ${ANTHROPIC_MODELS_URL} → empty catalog`);
      }
      return collected;
    }
    cursor = body.last_id;
  }
  throw new Error(`GET ${ANTHROPIC_MODELS_URL} → still paginating after ${MAX_PAGES} pages`);
}

/** `<alias>-<YYYYMMDD>` → `<alias>`; anything else unchanged. */
export function undated(id: string): string {
  return id.replace(/-\d{8}$/, "");
}

export function applyAnthropic(
  registry: Registry,
  catalog: AnthropicModel[],
  today: string,
): { registry: Registry; result: SourceResult } {
  const next = structuredClone(registry);
  const changes: Change[] = [];
  const notes: string[] = [];

  const byName = new Map<string, AnthropicModel>();
  for (const model of catalog) {
    byName.set(model.id, model);
    const alias = undated(model.id);
    if (!byName.has(alias)) {
      byName.set(alias, model);
    }
  }

  for (const offering of next.offerings) {
    if (offering.provider !== "anthropic" || offering.hidden) {
      continue;
    }
    const family = next.families[offering.family];
    if (family === undefined) {
      continue;
    }
    const entry = byName.get(offering.wireId ?? offering.family);
    observePresence(offering, entry !== undefined, "Anthropic", today, changes, notes);
    if (entry === undefined) {
      continue;
    }
    const window = entry.max_input_tokens;
    const maxOut = entry.max_tokens;
    if (!isPositiveInt(window) || !isPositiveInt(maxOut)) {
      notes.push(`anthropic/${offering.family}: catalog entry carries no limits`);
      continue;
    }
    if (window !== family.contextWindow) {
      changes.push({ target: `family ${offering.family}`, field: "contextWindow", from: family.contextWindow, to: window });
      family.contextWindow = window;
    }
    if (maxOut !== family.maxTokens) {
      changes.push({ target: `family ${offering.family}`, field: "maxTokens", from: family.maxTokens, to: maxOut });
      family.maxTokens = maxOut;
    }
  }

  return { registry: next, result: { source: "Anthropic", changes, notes } };
}

/**
 * An `anthropic/` route for every live Anthropic-made family the catalog
 * serves and this registry does not yet route there. The wire id is the
 * hyphenated spelling Anthropic answers to, carried only when it differs.
 */
export function discoverAnthropic(
  registry: Registry,
  catalog: AnthropicModel[],
): { registry: Registry; result: SourceResult } {
  const next = structuredClone(registry);
  const changes: Change[] = [];
  const names = new Set<string>();
  for (const model of catalog) {
    names.add(model.id);
    names.add(undated(model.id));
  }
  for (const [id, family] of Object.entries(next.families)) {
    if (family.maker !== "anthropic" || family.capabilities.imageGeneration) {
      continue;
    }
    if (familyHasRoute(next, id, "anthropic") || !familyIsLive(next, id)) {
      continue;
    }
    const wire = id.replaceAll(".", "-");
    if (!names.has(wire)) {
      continue;
    }
    addRoute(next, { provider: "anthropic", family: id, ...(wire !== id ? { wireId: wire } : {}) }, changes);
  }
  return { registry: next, result: { source: "Anthropic", changes, notes: [] } };
}
