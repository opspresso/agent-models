/**
 * OpenRouter's public catalog — `GET /api/v1/models`, no key — is the one
 * source every run has. It states, per model, a price in USD per token, a
 * context window, and a max completion size.
 *
 * What it is allowed to change:
 *
 *   - A family whose only routes are OpenRouter *is* what OpenRouter serves,
 *     so its price, window and output cap follow the catalog.
 *   - A family the vendor also serves keeps the vendor's numbers; the
 *     OpenRouter offering carries a price override only while the router's
 *     rate differs from the family's, and loses it the day they agree again.
 *   - Image-generation families are left alone: their per-image price lives in
 *     a different endpoint and a different unit.
 *
 * An id the catalog no longer lists is reported, never hidden: a route is
 * retired by a person, because an outage and a retirement look the same from
 * here for one day.
 */

import type { ModelPricing, Registry } from "../registry.ts";
import { fetchJson, isPositiveInt, perMillion, samePricing, type Change, type SourceResult } from "./types.ts";

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
/**
 * The dedicated drawing models live in a second catalog and not in `/models`:
 * `openai/gpt-image-2` and the Grok image models appear only here. Read for
 * existence alone — the per-image price is in yet another endpoint, in a
 * different unit, and stays hand-kept.
 */
export const OPENROUTER_IMAGE_MODELS_URL = "https://openrouter.ai/api/v1/images/models";

export interface OpenRouterModel {
  id: string;
  context_length?: number | null;
  pricing?: {
    prompt?: string;
    completion?: string;
    input_cache_read?: string;
  };
  top_provider?: {
    max_completion_tokens?: number | null;
  } | null;
}

export interface OpenRouterCatalog {
  models: OpenRouterModel[];
  /** Ids the image catalog lists. */
  imageIds: string[];
}

async function fetchData(url: string, fetchFn: typeof fetch): Promise<unknown[]> {
  const body = (await fetchJson(url, {}, fetchFn)) as { data?: unknown };
  if (!Array.isArray(body.data)) {
    throw new Error(`GET ${url} → no "data" array`);
  }
  return body.data;
}

export async function fetchOpenRouterCatalog(fetchFn: typeof fetch = fetch): Promise<OpenRouterCatalog> {
  const [models, images] = await Promise.all([
    fetchData(OPENROUTER_MODELS_URL, fetchFn),
    fetchData(OPENROUTER_IMAGE_MODELS_URL, fetchFn),
  ]);
  return {
    models: models as OpenRouterModel[],
    imageIds: images
      .map((entry) => (typeof entry === "object" && entry !== null ? (entry as { id?: unknown }).id : undefined))
      .filter((id): id is string => typeof id === "string"),
  };
}

type TokenPricing = Pick<ModelPricing, "inputPer1M" | "outputPer1M" | "cachedInputPer1M">;

/** The router's token price, or null when it states none (a free or unpriced listing). */
function tokenPricing(model: OpenRouterModel): TokenPricing | null {
  const prompt = Number(model.pricing?.prompt);
  const completion = Number(model.pricing?.completion);
  if (!(prompt > 0) || !(completion > 0)) {
    return null;
  }
  const cached = Number(model.pricing?.input_cache_read);
  return {
    inputPer1M: perMillion(prompt),
    outputPer1M: perMillion(completion),
    ...(cached > 0 ? { cachedInputPer1M: perMillion(cached) } : {}),
  };
}

function pickTokenPricing(pricing: Partial<ModelPricing>): TokenPricing {
  return {
    inputPer1M: pricing.inputPer1M as number,
    outputPer1M: pricing.outputPer1M as number,
    ...(pricing.cachedInputPer1M !== undefined ? { cachedInputPer1M: pricing.cachedInputPer1M } : {}),
  };
}

export function applyOpenRouter(
  registry: Registry,
  catalog: OpenRouterModel[],
  imageIds: readonly string[] = [],
): { registry: Registry; result: SourceResult } {
  const next = structuredClone(registry);
  const byId = new Map(catalog.map((model) => [model.id, model]));
  const drawn = new Set(imageIds);
  const changes: Change[] = [];
  const notes: string[] = [];

  for (const offering of next.offerings) {
    if (offering.provider !== "openrouter" || offering.wireId === undefined) {
      continue;
    }
    const id = `openrouter/${offering.family}`;
    const family = next.families[offering.family];
    if (family === undefined) {
      continue;
    }
    const entry = byId.get(offering.wireId);
    if (family.capabilities.imageGeneration) {
      if (entry === undefined && !drawn.has(offering.wireId) && !offering.hidden) {
        notes.push(`${id}: in neither of OpenRouter's catalogs (wireId ${offering.wireId})`);
      }
      continue;
    }
    if (entry === undefined) {
      if (!offering.hidden) {
        notes.push(`${id}: not in OpenRouter's catalog (wireId ${offering.wireId})`);
      }
      continue;
    }
    const routerPrice = tokenPricing(entry);
    if (routerPrice === null) {
      notes.push(`${id}: OpenRouter lists no token price`);
      continue;
    }

    const routerOnly = next.offerings
      .filter((other) => other.family === offering.family)
      .every((other) => other.provider === "openrouter");

    if (routerOnly) {
      const familyPrice = pickTokenPricing(family.pricing);
      if (!samePricing(familyPrice, routerPrice)) {
        changes.push({ target: `family ${offering.family}`, field: "pricing", from: familyPrice, to: routerPrice });
        family.pricing = { ...routerPrice };
      }
      const window = entry.context_length;
      if (isPositiveInt(window) && window !== family.contextWindow) {
        changes.push({ target: `family ${offering.family}`, field: "contextWindow", from: family.contextWindow, to: window });
        family.contextWindow = window;
      }
      const maxOut = entry.top_provider?.max_completion_tokens;
      if (isPositiveInt(maxOut) && maxOut !== family.maxTokens) {
        if (maxOut > family.contextWindow) {
          notes.push(`${id}: OpenRouter states max_completion_tokens ${maxOut} above the ${family.contextWindow} window; left alone`);
        } else {
          changes.push({ target: `family ${offering.family}`, field: "maxTokens", from: family.maxTokens, to: maxOut });
          family.maxTokens = maxOut;
        }
      }
      if (offering.pricing !== undefined) {
        changes.push({ target: `offering ${id}`, field: "pricing", from: offering.pricing, to: undefined });
        delete offering.pricing;
      }
      continue;
    }

    const familyPrice = pickTokenPricing(family.pricing);
    if (samePricing(familyPrice, routerPrice)) {
      if (offering.pricing !== undefined) {
        changes.push({ target: `offering ${id}`, field: "pricing", from: offering.pricing, to: undefined });
        delete offering.pricing;
      }
    } else if (!samePricing(offering.pricing, routerPrice)) {
      changes.push({ target: `offering ${id}`, field: "pricing", from: offering.pricing, to: routerPrice });
      offering.pricing = { ...routerPrice };
    }
    const window = entry.context_length;
    if (isPositiveInt(window) && window !== family.contextWindow) {
      notes.push(`${id}: OpenRouter states a ${window} window; the family says ${family.contextWindow}`);
    }
  }

  return { registry: next, result: { source: "OpenRouter", changes, notes } };
}
