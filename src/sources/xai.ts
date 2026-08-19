/**
 * xAI publishes its prices in the catalog itself — `GET /v1/language-models`
 * carries `prompt_text_token_price`, `cached_prompt_text_token_price` and
 * `completion_text_token_price` beside each model, **in units of 1e-10 USD per
 * token**: `12500` is $1.25 per million. The unit is the whole trap; a number
 * read as cents or as dollars lands an order of magnitude off.
 *
 * The catalog lists canonical ids only, with every accepted spelling in an
 * `aliases` array — `grok-4.20` is an alias of `grok-4.20-0309-reasoning` —
 * so a family is matched on either. A hidden route is not looked up at all.
 *
 * Only the text families' token prices move. The drawing models are priced
 * per image, from what an edit was actually billed, and stay hand-kept — they
 * are only looked up in their own catalog so a retirement is noticed.
 */

import type { Registry } from "../registry.ts";
import { observePresence } from "./presence.ts";
import { addRoute, familyHasRoute, familyIsLive } from "./routes.ts";
import { fetchJson, samePricing, type Change, type SourceResult } from "./types.ts";

export const XAI_LANGUAGE_MODELS_URL = "https://api.x.ai/v1/language-models";
/** The drawing models' own catalog — read for existence; their per-image price stays hand-kept. */
export const XAI_IMAGE_MODELS_URL = "https://api.x.ai/v1/image-generation-models";

/** 1e-10 USD per token → USD per million tokens. */
const TICKS_PER_USD_PER_MILLION = 10_000;

export interface XaiLanguageModel {
  id: string;
  aliases?: string[];
  prompt_text_token_price?: number;
  cached_prompt_text_token_price?: number;
  completion_text_token_price?: number;
}

export interface XaiCatalog {
  language: XaiLanguageModel[];
  /** The image catalog's ids and aliases — the names it answers to. */
  imageNames: string[];
}

async function fetchModels(url: string, apiKey: string, fetchFn: typeof fetch): Promise<unknown[]> {
  const body = (await fetchJson(url, { headers: { Authorization: `Bearer ${apiKey}` } }, fetchFn)) as {
    models?: unknown;
  };
  if (!Array.isArray(body.models) || body.models.length === 0) {
    throw new Error(`GET ${url} → no "models" array, or an empty one`);
  }
  return body.models;
}

export async function fetchXaiCatalog(apiKey: string, fetchFn: typeof fetch = fetch): Promise<XaiCatalog> {
  const [language, images] = await Promise.all([
    fetchModels(XAI_LANGUAGE_MODELS_URL, apiKey, fetchFn),
    fetchModels(XAI_IMAGE_MODELS_URL, apiKey, fetchFn),
  ]);
  const imageNames: string[] = [];
  for (const entry of images as Array<{ id?: unknown; aliases?: unknown }>) {
    if (typeof entry.id === "string") {
      imageNames.push(entry.id);
    }
    if (Array.isArray(entry.aliases)) {
      imageNames.push(...entry.aliases.filter((alias): alias is string => typeof alias === "string"));
    }
  }
  return { language: language as XaiLanguageModel[], imageNames };
}

function ticksToPerMillion(ticks: number | undefined): number | undefined {
  if (typeof ticks !== "number" || !Number.isFinite(ticks) || ticks < 0) {
    return undefined;
  }
  return Number((ticks / TICKS_PER_USD_PER_MILLION).toFixed(8));
}

export function applyXai(
  registry: Registry,
  catalog: XaiCatalog,
  today: string,
): { registry: Registry; result: SourceResult } {
  const next = structuredClone(registry);
  const changes: Change[] = [];
  const notes: string[] = [];

  const byName = new Map<string, XaiLanguageModel>();
  for (const model of catalog.language) {
    byName.set(model.id, model);
    for (const alias of model.aliases ?? []) {
      byName.set(alias, model);
    }
  }
  const drawn = new Set(catalog.imageNames);

  for (const offering of next.offerings) {
    if (offering.provider !== "xai" || offering.hidden) {
      continue;
    }
    const family = next.families[offering.family];
    if (family === undefined) {
      continue;
    }
    const name = offering.wireId ?? offering.family;
    if (family.capabilities.imageGeneration) {
      observePresence(offering, drawn.has(name), "xAI", today, changes, notes);
      continue;
    }
    const entry = byName.get(name);
    observePresence(offering, entry !== undefined, "xAI", today, changes, notes);
    if (entry === undefined) {
      continue;
    }
    const input = ticksToPerMillion(entry.prompt_text_token_price);
    const output = ticksToPerMillion(entry.completion_text_token_price);
    const cached = ticksToPerMillion(entry.cached_prompt_text_token_price);
    if (input === undefined || output === undefined || !(input > 0) || !(output > 0)) {
      notes.push(`xai/${offering.family}: xAI lists no token price`);
      continue;
    }
    const vendorPrice = {
      inputPer1M: input,
      outputPer1M: output,
      ...(cached !== undefined && cached > 0 ? { cachedInputPer1M: cached } : {}),
    };
    const current = {
      inputPer1M: family.pricing.inputPer1M,
      outputPer1M: family.pricing.outputPer1M,
      ...(family.pricing.cachedInputPer1M !== undefined ? { cachedInputPer1M: family.pricing.cachedInputPer1M } : {}),
    };
    if (!samePricing(current, vendorPrice)) {
      changes.push({ target: `family ${offering.family}`, field: "pricing", from: current, to: vendorPrice });
      family.pricing = { ...vendorPrice };
    }
  }

  return { registry: next, result: { source: "xAI", changes, notes } };
}

/** The names the language catalog answers to — ids and every alias. */
function languageNames(catalog: XaiCatalog): Set<string> {
  const names = new Set<string>();
  for (const model of catalog.language) {
    names.add(model.id);
    for (const alias of model.aliases ?? []) {
      names.add(alias);
    }
  }
  return names;
}

/**
 * An `xai/` route for every live xAI-made text family the catalog serves under
 * the family's own name and this registry does not yet route there. The
 * family's price follows xAI from then on (`applyXai`).
 */
export function discoverXai(registry: Registry, catalog: XaiCatalog): { registry: Registry; result: SourceResult } {
  const next = structuredClone(registry);
  const changes: Change[] = [];
  const names = languageNames(catalog);
  for (const [id, family] of Object.entries(next.families)) {
    if (family.maker !== "xai" || family.capabilities.imageGeneration) {
      continue;
    }
    if (familyHasRoute(next, id, "xai") || !familyIsLive(next, id) || !names.has(id)) {
      continue;
    }
    addRoute(next, { provider: "xai", family: id }, changes);
  }
  return { registry: next, result: { source: "xAI", changes, notes: [] } };
}
