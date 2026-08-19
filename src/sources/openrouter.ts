/**
 * OpenRouter's public catalog — `GET /api/v1/models`, no key — is the one
 * source every run has. It states, per model, a price in USD per token, a
 * context window, and a max completion size. That price is the *default
 * endpoint's*, after whatever promotional discount that endpoint carries; the
 * discount itself is published only per endpoint, by
 * `GET /api/v1/models/{id}/endpoints`, which is read for every live route so
 * the catalog can say that a rate is a promotion and by how much.
 *
 * What it is allowed to change:
 *
 *   - A family whose only routes are OpenRouter *is* what OpenRouter serves,
 *     so its price, discount, window and output cap follow the catalog.
 *   - A family the vendor also serves keeps the vendor's numbers; the
 *     OpenRouter offering carries a price override only while the router's
 *     rate differs from the family's, and loses it the day they agree again.
 *   - Image-generation families are left alone: their per-image price lives in
 *     a different endpoint and a different unit. They are still looked up in
 *     the image catalog, so a retirement is noticed.
 *   - A live route the catalogs no longer list is recorded as missing and
 *     hidden after the grace period (`presence.ts`) — never deleted.
 */

import type { ModelPricing, Registry } from "../registry.ts";
import { observePresence } from "./presence.ts";
import { fetchJson, isPositiveInt, perMillion, samePricing, type Change, type SourceResult } from "./types.ts";

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
/**
 * The dedicated drawing models live in a second catalog and not in `/models`:
 * `openai/gpt-image-2` and the Grok image models appear only here. Read for
 * existence alone — the per-image price is in yet another endpoint, in a
 * different unit, and stays hand-kept.
 */
export const OPENROUTER_IMAGE_MODELS_URL = "https://openrouter.ai/api/v1/images/models";

export function openRouterEndpointsUrl(id: string): string {
  return `${OPENROUTER_MODELS_URL}/${id}/endpoints`;
}

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

export interface OpenRouterEndpoint {
  tag?: string;
  provider_name?: string;
  pricing?: {
    prompt?: string;
    completion?: string;
    /** Promotional discount as a fraction; the endpoint's rates are after it. */
    discount?: number;
  };
}

export interface OpenRouterCatalog {
  models: OpenRouterModel[];
  /** Ids the image catalog lists. */
  imageIds: string[];
  /** Per model id, its endpoints — or null when that one request failed. */
  endpoints: Record<string, OpenRouterEndpoint[] | null>;
}

async function fetchData(url: string, fetchFn: typeof fetch): Promise<unknown[]> {
  const body = (await fetchJson(url, {}, fetchFn)) as { data?: unknown };
  if (!Array.isArray(body.data)) {
    throw new Error(`GET ${url} → no "data" array`);
  }
  return body.data;
}

function idsOf(entries: unknown[]): string[] {
  return entries
    .map((entry) => (typeof entry === "object" && entry !== null ? (entry as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === "string");
}

/** How many endpoint requests are in flight at once — polite, and fast enough for ~40 routes. */
const ENDPOINT_CONCURRENCY = 4;

/**
 * The catalogs, plus the endpoints of every id in `endpointIds` that `/models`
 * lists. An empty `/models` is an error and not a catalog: read as one, it
 * would start the retirement clock on every route at once.
 *
 * One endpoints request failing is not the source failing — it is recorded as
 * null and the route's discount is left as it was — because a single id that
 * 404s is exactly what a retirement looks like, and the rest of the catalog is
 * still good.
 */
export async function fetchOpenRouterCatalog(
  endpointIds: readonly string[],
  fetchFn: typeof fetch = fetch,
): Promise<OpenRouterCatalog> {
  const [models, images] = await Promise.all([
    fetchData(OPENROUTER_MODELS_URL, fetchFn),
    fetchData(OPENROUTER_IMAGE_MODELS_URL, fetchFn),
  ]);
  if (models.length === 0) {
    throw new Error(`GET ${OPENROUTER_MODELS_URL} → empty catalog`);
  }
  const listed = new Set(idsOf(models));
  const endpoints: Record<string, OpenRouterEndpoint[] | null> = {};
  const queue = endpointIds.filter((id) => listed.has(id));
  await Promise.all(
    Array.from({ length: ENDPOINT_CONCURRENCY }, async () => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        try {
          const body = (await fetchJson(openRouterEndpointsUrl(id), {}, fetchFn)) as {
            data?: { endpoints?: unknown };
          };
          endpoints[id] = Array.isArray(body.data?.endpoints) ? (body.data.endpoints as OpenRouterEndpoint[]) : [];
        } catch {
          endpoints[id] = null;
        }
      }
    }),
  );
  return { models: models as OpenRouterModel[], imageIds: idsOf(images), endpoints };
}

type TokenPricing = Pick<ModelPricing, "inputPer1M" | "outputPer1M" | "cachedInputPer1M" | "discount">;

/** The router's token price, or null when it states none (a free or unpriced listing). */
function tokenPricing(model: OpenRouterModel): Omit<TokenPricing, "discount"> | null {
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

/**
 * The discount behind a `/models` price: that of the first endpoint charging
 * exactly the catalog's prompt and completion rates — the default one, which
 * is what the catalog's price is quoting. `undefined` when the endpoints were
 * not read — a failed request or one never made — so the known discount is
 * kept; `null` when they were read and no endpoint at that price carries one.
 */
export function catalogDiscount(
  model: OpenRouterModel,
  endpoints: OpenRouterEndpoint[] | null | undefined,
): number | undefined | null {
  if (endpoints === null || endpoints === undefined) {
    return undefined;
  }
  const prompt = Number(model.pricing?.prompt);
  const completion = Number(model.pricing?.completion);
  const match = endpoints.find(
    (endpoint) =>
      Number(endpoint.pricing?.prompt) === prompt && Number(endpoint.pricing?.completion) === completion,
  );
  const discount = match?.pricing?.discount;
  return typeof discount === "number" && discount > 0 && discount < 1 ? discount : null;
}

function pickTokenPricing(pricing: Partial<ModelPricing>): TokenPricing {
  return {
    inputPer1M: pricing.inputPer1M as number,
    outputPer1M: pricing.outputPer1M as number,
    ...(pricing.cachedInputPer1M !== undefined ? { cachedInputPer1M: pricing.cachedInputPer1M } : {}),
    ...(pricing.discount !== undefined ? { discount: pricing.discount } : {}),
  };
}

/** The router's rate with its discount, keeping the known discount when the endpoints were unreadable. */
function withDiscount(
  price: Omit<TokenPricing, "discount">,
  discount: number | undefined | null,
  known: number | undefined,
): TokenPricing {
  const effective = discount === undefined ? known : discount === null ? undefined : discount;
  return { ...price, ...(effective !== undefined ? { discount: effective } : {}) };
}

export function applyOpenRouter(
  registry: Registry,
  catalog: OpenRouterCatalog,
  today: string,
): { registry: Registry; result: SourceResult } {
  const next = structuredClone(registry);
  const byId = new Map(catalog.models.map((model) => [model.id, model]));
  const drawn = new Set(catalog.imageIds);
  const changes: Change[] = [];
  const notes: string[] = [];

  for (const offering of next.offerings) {
    if (offering.provider !== "openrouter" || offering.wireId === undefined || offering.hidden) {
      continue;
    }
    const id = `openrouter/${offering.family}`;
    const family = next.families[offering.family];
    if (family === undefined) {
      continue;
    }
    const entry = byId.get(offering.wireId);

    if (family.capabilities.imageGeneration) {
      observePresence(offering, entry !== undefined || drawn.has(offering.wireId), "OpenRouter", today, changes, notes);
      continue;
    }
    observePresence(offering, entry !== undefined, "OpenRouter", today, changes, notes);
    if (entry === undefined) {
      continue;
    }
    const routerPrice = tokenPricing(entry);
    if (routerPrice === null) {
      notes.push(`${id}: OpenRouter lists no token price`);
      continue;
    }
    const discount = catalogDiscount(entry, catalog.endpoints[offering.wireId]);
    if (catalog.endpoints[offering.wireId] === null) {
      notes.push(`${id}: OpenRouter's endpoints could not be read; discount left as it was`);
    }

    const routerOnly = next.offerings
      .filter((other) => other.family === offering.family)
      .every((other) => other.provider === "openrouter");

    if (routerOnly) {
      const familyPrice = pickTokenPricing(family.pricing);
      const price = withDiscount(routerPrice, discount, family.pricing.discount);
      if (!samePricing(familyPrice, price)) {
        changes.push({ target: `family ${offering.family}`, field: "pricing", from: familyPrice, to: price });
        family.pricing = { ...price };
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
    const price = withDiscount(routerPrice, discount, offering.pricing?.discount);
    if (samePricing(familyPrice, price)) {
      if (offering.pricing !== undefined) {
        changes.push({ target: `offering ${id}`, field: "pricing", from: offering.pricing, to: undefined });
        delete offering.pricing;
      }
    } else if (!samePricing(offering.pricing, price)) {
      changes.push({ target: `offering ${id}`, field: "pricing", from: offering.pricing, to: price });
      offering.pricing = { ...price };
    }
    const window = entry.context_length;
    if (isPositiveInt(window) && window !== family.contextWindow) {
      notes.push(`${id}: OpenRouter states a ${window} window; the family says ${family.contextWindow}`);
    }
  }

  return { registry: next, result: { source: "OpenRouter", changes, notes } };
}
