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
 *
 * And what it may add (`discoverOpenRouter`):
 *
 *   - A route to a family this registry already has, when the catalog lists
 *     the family under its maker's vendor slug — the family is curated, the
 *     router is one API, and "also via openrouter" is cheap to be right about.
 *   - A new family, when a known maker's model appeared in the catalog within
 *     `DISCOVERY_WINDOW_DAYS`, is a priced text model, and states its output
 *     cap. Everything else it notices — an unknown maker, an image model, a
 *     listing without an output cap — is reported for a person, because each
 *     needs a judgement or a number this source does not carry.
 */

import type { ModelCapabilities, ModelFamily, ModelPricing, PlacedOffering, Registry } from "../registry.ts";
import { daysBetween, observePresence, utcDate } from "./presence.ts";
import { addRoute, familyIsLive } from "./routes.ts";
import { fetchJson, isPositiveInt, perMillion, samePricing, type Change, type SourceResult } from "./types.ts";

/** How far back a first listing counts as new. Older listings are the backlog, which is a person's. */
export const DISCOVERY_WINDOW_DAYS = 30;
/** An announced end further out than this is a placeholder, not a plan. */
export const EXPIRATION_HORIZON_DAYS = 365;

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
  name?: string;
  /** Unix seconds the listing was created — when OpenRouter first had it. */
  created?: number;
  context_length?: number | null;
  pricing?: {
    prompt?: string;
    completion?: string;
    input_cache_read?: string;
  };
  top_provider?: {
    max_completion_tokens?: number | null;
  } | null;
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
  };
  supported_parameters?: string[];
  /** When OpenRouter has announced the listing's end. */
  expiration_date?: string | null;
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
  selectEndpointIds: (models: OpenRouterModel[]) => readonly string[],
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
  const queue = [...new Set(selectEndpointIds(models as OpenRouterModel[]))].filter((id) => listed.has(id));
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
    if (typeof entry.expiration_date === "string" && entry.expiration_date !== "") {
      // Some listings carry a placeholder decades out; only a real horizon is news.
      const ends = entry.expiration_date.slice(0, 10);
      const inDays = daysBetween(today, ends);
      if (Number.isFinite(inDays) && inDays <= EXPIRATION_HORIZON_DAYS) {
        notes.push(`${id}: OpenRouter has announced this listing ends ${ends}`);
      }
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

// ---------------------------------------------------------------------------
// Discovery — what the catalog lists that this registry does not
// ---------------------------------------------------------------------------

/** `vendor/slug`, or null for an alias entry (`~vendor/...`) or a bare id. */
function splitId(id: string): { vendor: string; slug: string } | null {
  const slash = id.indexOf("/");
  if (slash <= 0 || id.startsWith("~")) {
    return null;
  }
  return { vendor: id.slice(0, slash), slug: id.slice(slash + 1) };
}

/** `:free`, `:batch`, `:nitro`, `:thinking` — a serving variant, not a model. */
function isVariant(slug: string): boolean {
  return slug.includes(":");
}

/** `-20250929`, `-0813`, `-2025`: a dated snapshot; the undated alias is what a registry names. */
function isDated(slug: string): boolean {
  return /-\d{4}(\d{4})?$/.test(slug);
}

function outputs(model: OpenRouterModel, modality: string): boolean {
  return (model.architecture?.output_modalities ?? ["text"]).includes(modality);
}

/** "Z.ai: GLM 5.3" → "GLM 5.3"; a name without the vendor prefix is kept as is. */
function displayNameOf(model: OpenRouterModel, slug: string): string {
  const raw = (model.name ?? "").trim();
  const name = raw.includes(": ") ? raw.slice(raw.indexOf(": ") + 2).trim() : raw;
  return name === "" ? slug : name;
}

function capabilitiesOf(model: OpenRouterModel): ModelCapabilities {
  const params = new Set(model.supported_parameters ?? []);
  const inputs = new Set(model.architecture?.input_modalities ?? ["text"]);
  return {
    tools: params.has("tools"),
    // `response_format` alone is JSON mode; a schema needs `structured_outputs`.
    structuredOutput: params.has("structured_outputs"),
    imageInput: inputs.has("image"),
    reasoning: params.has("reasoning") || params.has("include_reasoning"),
  };
}

function isRecent(model: OpenRouterModel, today: string): boolean {
  if (typeof model.created !== "number" || !Number.isFinite(model.created)) {
    return false;
  }
  return daysBetween(utcDate(new Date(model.created * 1000)), today) <= DISCOVERY_WINDOW_DAYS;
}

/**
 * The ids whose endpoints discovery will want read — the known makers' recent
 * listings (a new family) and their listings named after a family this
 * registry has (a new route) — so either carries its discount from the first
 * day rather than the second.
 */
export function discoveryEndpointIds(registry: Registry, models: OpenRouterModel[], today: string): string[] {
  const known = new Set(Object.values(registry.openrouterVendors));
  return models
    .filter((model) => {
      const parts = splitId(model.id);
      if (parts === null || !known.has(parts.vendor) || isVariant(parts.slug)) {
        return false;
      }
      return isRecent(model, today) || registry.families[parts.slug] !== undefined;
    })
    .map((model) => model.id);
}

export function discoverOpenRouter(
  registry: Registry,
  catalog: OpenRouterCatalog,
  today: string,
): { registry: Registry; result: SourceResult } {
  const next = structuredClone(registry);
  const changes: Change[] = [];
  const notes: string[] = [];
  const makerOfVendor = new Map(Object.entries(next.openrouterVendors).map(([maker, vendor]) => [vendor, maker]));
  const unknownVendors = new Map<string, string[]>();
  // Ids this registry already routes to, whatever family name it files them
  // under — `upstage/solar-pro4` is `solar-pro-4` here, not a second family.
  const routed = new Set(next.offerings.filter((o) => o.provider === "openrouter").map((o) => o.wireId));

  for (const model of catalog.models) {
    const parts = splitId(model.id);
    if (parts === null || isVariant(parts.slug) || routed.has(model.id) || !outputs(model, "text") && !outputs(model, "image")) {
      continue;
    }
    const { vendor, slug } = parts;
    const maker = makerOfVendor.get(vendor);

    if (maker === undefined) {
      if (isRecent(model, today) && !isDated(slug) && tokenPricing(model) !== null) {
        unknownVendors.set(vendor, [...(unknownVendors.get(vendor) ?? []), slug]);
      }
      continue;
    }

    const family = next.families[slug];
    if (family !== undefined) {
      if (family.maker !== maker) {
        notes.push(`openrouter: ${model.id} names family "${slug}", which this registry files under ${family.maker}; left alone`);
        continue;
      }
      if (family.capabilities.imageGeneration) {
        // An image route is verified by drawing with it, which this source cannot do.
        continue;
      }
      if (!familyIsLive(next, slug) || next.offerings.some((o) => o.provider === "openrouter" && o.family === slug)) {
        continue;
      }
      // A slug is a weak name for a model: `qwen/qwen3-235b-a22b` is the
      // original, while this registry's `qwen3-235b-a22b` is the Instruct 2507.
      // The window is the cheapest identity check there is — the same model
      // has one — so a listing that states another one is left for a person.
      if (model.context_length !== family.contextWindow) {
        notes.push(
          `openrouter: ${model.id} could route family "${slug}", but states a ${model.context_length ?? "missing"} window against the family's ${family.contextWindow} — add the route by hand if it is the same model`,
        );
        continue;
      }
      const offering: PlacedOffering = { provider: "openrouter", family: slug, wireId: model.id };
      const narrowed = capabilitiesOf(model);
      const caps: Partial<ModelCapabilities> = {};
      if (family.capabilities.tools && !narrowed.tools) caps.tools = false;
      if (family.capabilities.structuredOutput && !narrowed.structuredOutput) caps.structuredOutput = false;
      if (Object.keys(caps).length > 0) offering.capabilities = caps;
      addRoute(next, offering, changes);
      continue;
    }

    // A family this registry does not have.
    if (!isRecent(model, today) || isDated(slug)) {
      continue;
    }
    const price = tokenPricing(model);
    if (price === null) {
      continue;
    }
    if (outputs(model, "image")) {
      notes.push(`openrouter: new image model ${model.id} — per-image pricing is read from another endpoint; add it by hand`);
      continue;
    }
    const maxOut = model.top_provider?.max_completion_tokens;
    const window = model.context_length;
    if (!isPositiveInt(window)) {
      notes.push(`openrouter: new model ${model.id} states no context window; add it by hand`);
      continue;
    }
    if (!isPositiveInt(maxOut) || maxOut > window) {
      notes.push(`openrouter: new model ${model.id} states no usable max output (${maxOut ?? "none"} against a ${window} window); add it by hand`);
      continue;
    }
    const discount = catalogDiscount(model, catalog.endpoints[model.id]);
    const created: ModelFamily & { maker: string } = {
      maker,
      displayName: displayNameOf(model, slug),
      pricing: { ...price, ...(typeof discount === "number" ? { discount } : {}) },
      capabilities: capabilitiesOf(model),
      contextWindow: window,
      maxTokens: maxOut,
      note: `Added automatically on ${today} from OpenRouter's catalog (listed ${utcDate(new Date((model.created as number) * 1000))}); numbers and flags are OpenRouter's.`,
    };
    next.families[slug] = created;
    next.offerings.push({ provider: "openrouter", family: slug, wireId: model.id });
    changes.push({ target: `family ${slug}`, field: "added", from: undefined, to: `${created.displayName} via openrouter (${model.id})` });
  }

  for (const [vendor, slugs] of [...unknownVendors].sort()) {
    notes.push(
      `openrouter: ${slugs.length} recent model${slugs.length === 1 ? "" : "s"} from "${vendor}", not a known maker (${slugs.slice(0, 6).join(", ")}${slugs.length > 6 ? ", …" : ""}) — add the maker to makers.json and openrouter-vendors.json to adopt them`,
    );
  }

  return { registry: next, result: { source: "OpenRouter", changes, notes } };
}
