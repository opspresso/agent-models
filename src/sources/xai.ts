/**
 * xAI publishes its prices in the catalog itself — `GET /v1/language-models`
 * carries `prompt_text_token_price`, `cached_prompt_text_token_price` and
 * `completion_text_token_price` beside each model, **in units of 1e-10 USD per
 * token**: `12500` is $1.25 per million. The unit is the whole trap; a number
 * read as cents or as dollars lands an order of magnitude off.
 *
 * The catalog lists canonical ids only, with every accepted spelling in an
 * `aliases` array — `grok-4.20` is an alias of `grok-4.20-0309-reasoning` —
 * so a family is matched on either. A retired family (its xAI route hidden)
 * is not looked up at all: reporting it missing every day would say nothing.
 *
 * Only the text families' token prices move. The drawing models are priced
 * per image, from what an edit was actually billed, and stay hand-kept.
 */

import type { Registry } from "../registry.ts";
import { fetchJson, samePricing, type Change, type SourceResult } from "./types.ts";

export const XAI_LANGUAGE_MODELS_URL = "https://api.x.ai/v1/language-models";

/** 1e-10 USD per token → USD per million tokens. */
const TICKS_PER_USD_PER_MILLION = 10_000;

export interface XaiLanguageModel {
  id: string;
  aliases?: string[];
  prompt_text_token_price?: number;
  cached_prompt_text_token_price?: number;
  completion_text_token_price?: number;
}

export async function fetchXaiLanguageModels(
  apiKey: string,
  fetchFn: typeof fetch = fetch,
): Promise<XaiLanguageModel[]> {
  const body = (await fetchJson(
    XAI_LANGUAGE_MODELS_URL,
    { headers: { Authorization: `Bearer ${apiKey}` } },
    fetchFn,
  )) as { models?: unknown };
  if (!Array.isArray(body.models)) {
    throw new Error(`GET ${XAI_LANGUAGE_MODELS_URL} → no "models" array`);
  }
  return body.models as XaiLanguageModel[];
}

function ticksToPerMillion(ticks: number | undefined): number | undefined {
  if (typeof ticks !== "number" || !Number.isFinite(ticks) || ticks < 0) {
    return undefined;
  }
  return Number((ticks / TICKS_PER_USD_PER_MILLION).toFixed(8));
}

export function applyXai(
  registry: Registry,
  catalog: XaiLanguageModel[],
): { registry: Registry; result: SourceResult } {
  const next = structuredClone(registry);
  const changes: Change[] = [];
  const notes: string[] = [];

  const byName = new Map<string, XaiLanguageModel>();
  for (const model of catalog) {
    byName.set(model.id, model);
    for (const alias of model.aliases ?? []) {
      byName.set(alias, model);
    }
  }

  for (const offering of next.offerings) {
    if (offering.provider !== "xai" || offering.hidden) {
      continue;
    }
    const family = next.families[offering.family];
    if (family === undefined || family.capabilities.imageGeneration) {
      continue;
    }
    const entry = byName.get(offering.wireId ?? offering.family);
    if (entry === undefined) {
      notes.push(`xai/${offering.family}: not in xAI's language-models catalog`);
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
