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
 *   - An image family whose only route is OpenRouter follows the image
 *     endpoint's normalized token price, window and output cap.
 *   - Embedding, rerank and transcription families whose only route is
 *     OpenRouter follow their dedicated catalogs and native billing units.
 *   - A live route the catalogs no longer list is recorded as missing and
 *     hidden after the grace period (`presence.ts`) — never deleted.
 *
 * And what it may add (`discoverOpenRouter`):
 *
 *   - A route to a family this registry already has, when the catalog lists
 *     an eligible model under its maker's vendor slug — the family is curated,
 *     the router is one API, and "also via openrouter" is cheap to be right about.
 *   - A new family, when a known maker's model is a recent major-provider
 *     listing or ranks in OpenRouter's weekly top 20 open- or closed-weight
 *     models, is priced text and states its output cap in the aggregate model
 *     or at least one endpoint.
 *   - An image family and route when the model ranks in the weekly image top
 *     20 and its endpoint states a price and limits (including explicit zero
 *     limits for image-only models). Its maker is adopted with it when the
 *     vendor is new to the registry.
 *   - Embedding, rerank and transcription families and routes when the model
 *     ranks in the corresponding weekly top 20 and states usable metadata.
 *
 * Retention is deliberately wider than admission: text stays through the
 * weekly top 50 in its open/closed class, specialized models through their
 * top 30. A listing gets 90 days before ranking retirement starts, and a
 * major-maker text route is ranked only when no live vendor route backs its
 * family.
 */

import { isSafeSlug, type ModelCapabilities, type ModelFamily, type ModelPricing, type PlacedOffering, type Registry } from "../registry.ts";
import { daysBetween, observePresence, observeRankingEligibility, utcDate } from "./presence.ts";
import { addRoute, familyIsLive } from "./routes.ts";
import { fetchJson, isExternalId, isPositiveInt, perMillion, samePricing, type Change, type SourceResult } from "./types.ts";

/** How far back a first listing counts as new. Older listings are the backlog, which is a person's. */
export const DISCOVERY_WINDOW_DAYS = 30;
/** Fresh listings are not retired for low usage while adoption is still settling. */
export const RANKING_RETIREMENT_MIN_AGE_DAYS = 90;
/** An announced end further out than this is a placeholder, not a plan. */
export const EXPIRATION_HORIZON_DAYS = 365;

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
export const OPENROUTER_RANKINGS_URL = "https://openrouter.ai/api/frontend/v1/rankings/models?view=week";
export const OPENROUTER_IMAGE_RANKINGS_URL = "https://openrouter.ai/api/frontend/v1/rankings/modality-models?routeSegment=image&view=week";
export const OPENROUTER_EMBEDDING_RANKINGS_URL = "https://openrouter.ai/api/frontend/v1/rankings/modality-models?routeSegment=embeddings&view=week";
export const OPENROUTER_RERANK_RANKINGS_URL = "https://openrouter.ai/api/frontend/v1/rankings/modality-models?routeSegment=rerank&view=week";
export const OPENROUTER_TRANSCRIPTION_RANKINGS_URL = "https://openrouter.ai/api/frontend/v1/rankings/modality-models?routeSegment=transcription&view=week";
/**
 * The dedicated drawing models live in a second catalog and not in `/models`:
 * `openai/gpt-image-2` and the Grok image models appear only here. Read for
 * discovery and presence. Price and limits come from the model endpoints API.
 */
export const OPENROUTER_IMAGE_MODELS_URL = "https://openrouter.ai/api/v1/images/models";
/** The complete embeddings catalog; `/models` defaults to text output only. */
export const OPENROUTER_EMBEDDING_MODELS_URL = "https://openrouter.ai/api/v1/embeddings/models";
export const OPENROUTER_RERANK_MODELS_URL = `${OPENROUTER_MODELS_URL}?output_modalities=rerank`;
export const OPENROUTER_TRANSCRIPTION_MODELS_URL = `${OPENROUTER_MODELS_URL}?output_modalities=transcription`;

export function openRouterEndpointsUrl(id: string): string {
  return `${OPENROUTER_MODELS_URL}/${id}/endpoints`;
}

export interface OpenRouterModel {
  id: string;
  /** Stable identity used by the rankings feed, including its dated suffix. */
  canonical_slug?: string;
  /** OpenRouter's own open/closed signal: the rankings page treats a model with weights as open. */
  hugging_face_id?: string | null;
  name?: string;
  /** Unix seconds the listing was created — when OpenRouter first had it. */
  created?: number;
  context_length?: number | null;
  pricing?: {
    prompt?: string;
    completion?: string;
    input_cache_read?: string;
    image_output?: string;
    /** Enriched from the public model page because the Models API omits rerank SKUs. */
    rerank_input?: string;
    rerank_search?: string;
    transcription_input?: string;
    transcription_output?: string;
    transcription_minute?: string;
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
  context_length?: number | null;
  max_completion_tokens?: number | null;
  pricing?: {
    prompt?: string;
    completion?: string;
    input_cache_read?: string;
    image_output?: string;
    /** Promotional discount as a fraction; the endpoint's rates are after it. */
    discount?: number;
  };
}

export interface OpenRouterRanking {
  model_permaslug: string;
  variant_permaslug: string;
  total_completion_tokens: number;
  total_prompt_tokens: number;
}

export interface OpenRouterImageModel {
  id: string;
  name?: string;
  created?: number;
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
  };
}

export interface OpenRouterImageRanking {
  model_permaslug: string;
  variant_permaslug: string;
  image_output_requests: number;
}

export interface OpenRouterEmbeddingRanking {
  model_permaslug: string;
  variant_permaslug: string;
  count: number;
}

export interface OpenRouterCatalog {
  models: OpenRouterModel[];
  /** Ids the image catalog lists. */
  imageIds: string[];
  imageModels: OpenRouterImageModel[];
  /** Entries the dedicated embeddings catalog lists. */
  embeddingModels: OpenRouterModel[];
  rerankModels: OpenRouterModel[];
  transcriptionModels: OpenRouterModel[];
  /** Per model id, its endpoints — or null when that one request failed. */
  endpoints: Record<string, OpenRouterEndpoint[] | null>;
  /** Null when the public rankings feed failed or changed shape. */
  rankings: OpenRouterRanking[] | null;
  /** Null when the public image rankings feed failed or changed shape. */
  imageRankings: OpenRouterImageRanking[] | null;
  /** Null when the public embeddings rankings feed failed or changed shape. */
  embeddingRankings: OpenRouterEmbeddingRanking[] | null;
  /** Null when the public rerank rankings feed failed or changed shape. */
  rerankRankings: OpenRouterEmbeddingRanking[] | null;
  /** Null when the public transcription rankings feed failed or changed shape. */
  transcriptionRankings: OpenRouterEmbeddingRanking[] | null;
}

export interface OpenRouterDiscoveryOptions {
  /** Ignore the normal recency window while rebuilding OpenRouter from an empty route set. */
  bootstrap?: boolean;
}

async function fetchData(url: string, fetchFn: typeof fetch, complete = false): Promise<unknown[]> {
  const body = (await fetchJson(url, {}, fetchFn)) as { data?: unknown; total_count?: unknown; links?: { next?: unknown } };
  if (!Array.isArray(body.data)) {
    throw new Error(`GET ${url} → no "data" array`);
  }
  if (complete) {
    if (!Number.isInteger(body.total_count) || (body.total_count as number) < 0 || body.links === undefined || !("next" in body.links)) {
      throw new Error(`GET ${url} → missing completeness metadata`);
    }
    if (body.total_count !== body.data.length) {
      throw new Error(`GET ${url} → partial catalog (${body.data.length} of ${body.total_count} entries)`);
    }
    if (body.links.next !== null) {
      throw new Error(`GET ${url} → paginated catalog is incomplete`);
    }
  }
  return body.data;
}

function idsOf(entries: unknown[]): string[] {
  return entries
    .map((entry) => (typeof entry === "object" && entry !== null ? (entry as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === "string");
}

function isRanking(entry: unknown): entry is OpenRouterRanking {
  if (typeof entry !== "object" || entry === null) {
    return false;
  }
  const row = entry as Partial<OpenRouterRanking>;
  return typeof row.model_permaslug === "string"
    && typeof row.variant_permaslug === "string"
    && typeof row.total_completion_tokens === "number"
    && Number.isFinite(row.total_completion_tokens)
    && row.total_completion_tokens >= 0
    && typeof row.total_prompt_tokens === "number"
    && Number.isFinite(row.total_prompt_tokens)
    && row.total_prompt_tokens >= 0;
}

function isImageRanking(entry: unknown): entry is OpenRouterImageRanking {
  if (typeof entry !== "object" || entry === null) {
    return false;
  }
  const row = entry as Partial<OpenRouterImageRanking>;
  return typeof row.model_permaslug === "string"
    && typeof row.variant_permaslug === "string"
    && typeof row.image_output_requests === "number"
    && Number.isFinite(row.image_output_requests)
    && row.image_output_requests >= 0;
}

function isEmbeddingRanking(entry: unknown): entry is OpenRouterEmbeddingRanking {
  if (typeof entry !== "object" || entry === null) {
    return false;
  }
  const row = entry as Partial<OpenRouterEmbeddingRanking>;
  return typeof row.model_permaslug === "string"
    && typeof row.variant_permaslug === "string"
    && typeof row.count === "number"
    && Number.isFinite(row.count)
    && row.count >= 0;
}

function specialPrice(html: string, label: string): number | null {
  const escaped = label.replaceAll(" ", "\\s");
  const match = new RegExp(`sku_label\\\\\":\\\\\"${escaped}\\\\\",\\\\\"price\\\\\":\\\\\"([0-9.eE+-]+)\\\\\"`).exec(html);
  const value = Number(match?.[1]);
  return value > 0 && Number.isFinite(value) ? value : null;
}

function displayedPricing(html: string): string {
  return /displayPricing\\\":(\[[^\]]*\])/.exec(html)?.[1] ?? "";
}

/** The Models API currently reports zero for rerank SKUs; the public model page carries the billed unit. */
async function enrichRerankPricing(model: OpenRouterModel, fetchFn: typeof fetch): Promise<OpenRouterModel> {
  if (rerankPricing(model) !== null) {
    return model;
  }
  const url = `https://openrouter.ai/${model.id}`;
  try {
    const response = await fetchFn(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (!response.ok) {
      return model;
    }
    const stated = Number(response.headers?.get("content-length"));
    if (stated > 10 * 1024 * 1024) {
      return model;
    }
    const html = await response.text();
    if (html.length > 10 * 1024 * 1024) {
      return model;
    }
    const displayed = displayedPricing(html);
    const input = specialPrice(displayed, "Input tokens");
    const search = specialPrice(displayed, "Search units");
    if (input === null && search === null) {
      return model;
    }
    return {
      ...model,
      pricing: {
        ...model.pricing,
        ...(input !== null ? { rerank_input: String(input) } : {}),
        ...(search !== null ? { rerank_search: String(search) } : {}),
      },
    };
  } catch {
    return model;
  }
}

async function enrichTranscriptionPricing(model: OpenRouterModel, fetchFn: typeof fetch): Promise<OpenRouterModel> {
  if (transcriptionPricing(model) !== null) {
    return model;
  }
  const url = `https://openrouter.ai/${model.id}`;
  try {
    const response = await fetchFn(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (!response.ok) {
      return model;
    }
    const stated = Number(response.headers?.get("content-length"));
    if (stated > 10 * 1024 * 1024) {
      return model;
    }
    const html = await response.text();
    if (html.length > 10 * 1024 * 1024) {
      return model;
    }
    const displayed = displayedPricing(html);
    const perMinute = specialPrice(displayed, "Audio Minutes");
    const perSecond = specialPrice(displayed, "Audio Seconds");
    const perHour = specialPrice(displayed, "Audio Hours");
    const minute = perMinute
      ?? (perSecond === null ? null : Number((perSecond * 60).toFixed(8)))
      ?? (perHour === null ? null : Number((perHour / 60).toFixed(8)));
    const input = specialPrice(displayed, "Input Price") ?? specialPrice(displayed, "Input tokens");
    const output = specialPrice(displayed, "Output Price") ?? specialPrice(displayed, "Output tokens");
    if (minute === null && (input === null || output === null)) {
      return model;
    }
    return {
      ...model,
      pricing: {
        ...model.pricing,
        ...(minute !== null ? { transcription_minute: String(minute) } : {}),
        ...(input !== null ? { transcription_input: String(input) } : {}),
        ...(output !== null ? { transcription_output: String(output) } : {}),
      },
    };
  } catch {
    return model;
  }
}

async function enrichSpecialPricing(
  models: OpenRouterModel[],
  enrich: (model: OpenRouterModel) => Promise<OpenRouterModel>,
): Promise<OpenRouterModel[]> {
  const enriched = [...models];
  const queue = models.map((model, index) => ({ model, index }));
  await Promise.all(Array.from({ length: ENDPOINT_CONCURRENCY }, async () => {
    for (let entry = queue.shift(); entry !== undefined; entry = queue.shift()) {
      enriched[entry.index] = await enrich(entry.model);
    }
  }));
  return enriched;
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
  selectEndpointIds: (
    models: OpenRouterModel[],
    rankings: OpenRouterRanking[] | null,
  ) => readonly string[],
  fetchFn: typeof fetch = fetch,
): Promise<OpenRouterCatalog> {
  const rankingsRequest = fetchData(OPENROUTER_RANKINGS_URL, fetchFn).then(
    (data) => ({ ok: true as const, data }),
    () => ({ ok: false as const }),
  );
  const imageRankingsRequest = fetchData(OPENROUTER_IMAGE_RANKINGS_URL, fetchFn).then(
    (data) => ({ ok: true as const, data }),
    () => ({ ok: false as const }),
  );
  const embeddingRankingsRequest = fetchData(OPENROUTER_EMBEDDING_RANKINGS_URL, fetchFn).then(
    (data) => ({ ok: true as const, data }),
    () => ({ ok: false as const }),
  );
  const rerankRankingsRequest = fetchData(OPENROUTER_RERANK_RANKINGS_URL, fetchFn).then(
    (data) => ({ ok: true as const, data }),
    () => ({ ok: false as const }),
  );
  const transcriptionRankingsRequest = fetchData(OPENROUTER_TRANSCRIPTION_RANKINGS_URL, fetchFn).then(
    (data) => ({ ok: true as const, data }),
    () => ({ ok: false as const }),
  );
  const [models, images, embeddings, reranks, transcriptions, rankingsResult, imageRankingsResult, embeddingRankingsResult, rerankRankingsResult, transcriptionRankingsResult] = await Promise.all([
    fetchData(OPENROUTER_MODELS_URL, fetchFn, true),
    fetchData(OPENROUTER_IMAGE_MODELS_URL, fetchFn),
    fetchData(OPENROUTER_EMBEDDING_MODELS_URL, fetchFn, true),
    fetchData(OPENROUTER_RERANK_MODELS_URL, fetchFn, true),
    fetchData(OPENROUTER_TRANSCRIPTION_MODELS_URL, fetchFn, true),
    rankingsRequest,
    imageRankingsRequest,
    embeddingRankingsRequest,
    rerankRankingsRequest,
    transcriptionRankingsRequest,
  ]);
  if (models.length === 0) {
    throw new Error(`GET ${OPENROUTER_MODELS_URL} → empty catalog`);
  }
  // The same contract as /models: six image routes live only in this listing,
  // so an empty answer (an endpoint moved, a broken deploy) read as data would
  // start the retirement clock on all of them at once.
  if (images.length === 0) {
    throw new Error(`GET ${OPENROUTER_IMAGE_MODELS_URL} → empty catalog`);
  }
  if (embeddings.length === 0) {
    throw new Error(`GET ${OPENROUTER_EMBEDDING_MODELS_URL} → empty catalog`);
  }
  if (reranks.length === 0) {
    throw new Error(`GET ${OPENROUTER_RERANK_MODELS_URL} → empty catalog`);
  }
  if (transcriptions.length === 0) {
    throw new Error(`GET ${OPENROUTER_TRANSCRIPTION_MODELS_URL} → empty catalog`);
  }
  // The empty guards catch a missing list; these catch a renamed id field —
  // raw entries none of which carry an id would read as a catalog that
  // retired everything at once.
  if (!models.every((entry) => typeof entry === "object" && entry !== null && isExternalId((entry as { id?: unknown }).id))) {
    throw new Error(`GET ${OPENROUTER_MODELS_URL} → invalid or no usable entries (shape drift?)`);
  }
  if (!images.every((entry) => typeof entry === "object" && entry !== null && isExternalId((entry as { id?: unknown }).id))) {
    throw new Error(`GET ${OPENROUTER_IMAGE_MODELS_URL} → invalid or no usable entries (shape drift?)`);
  }
  if (!embeddings.every((entry) => typeof entry === "object" && entry !== null && isExternalId((entry as { id?: unknown }).id))) {
    throw new Error(`GET ${OPENROUTER_EMBEDDING_MODELS_URL} → invalid or no usable entries (shape drift?)`);
  }
  if (!reranks.every((entry) => typeof entry === "object" && entry !== null && isExternalId((entry as { id?: unknown }).id))) {
    throw new Error(`GET ${OPENROUTER_RERANK_MODELS_URL} → invalid or no usable entries (shape drift?)`);
  }
  if (!transcriptions.every((entry) => typeof entry === "object" && entry !== null && isExternalId((entry as { id?: unknown }).id))) {
    throw new Error(`GET ${OPENROUTER_TRANSCRIPTION_MODELS_URL} → invalid or no usable entries (shape drift?)`);
  }
  let rankings = rankingsResult.ok && rankingsResult.data.length > 0 && rankingsResult.data.every(isRanking)
    ? rankingsResult.data as OpenRouterRanking[]
    : null;
  let imageRankings = imageRankingsResult.ok
      && imageRankingsResult.data.length > 0
      && imageRankingsResult.data.every(isImageRanking)
    ? imageRankingsResult.data as OpenRouterImageRanking[]
    : null;
  let embeddingRankings = embeddingRankingsResult.ok
      && embeddingRankingsResult.data.length > 0
      && embeddingRankingsResult.data.every(isEmbeddingRanking)
    ? embeddingRankingsResult.data as OpenRouterEmbeddingRanking[]
    : null;
  let rerankRankings = rerankRankingsResult.ok
      && rerankRankingsResult.data.length > 0
      && rerankRankingsResult.data.every(isEmbeddingRanking)
    ? rerankRankingsResult.data as OpenRouterEmbeddingRanking[]
    : null;
  let transcriptionRankings = transcriptionRankingsResult.ok
      && transcriptionRankingsResult.data.length > 0
      && transcriptionRankingsResult.data.every(isEmbeddingRanking)
    ? transcriptionRankingsResult.data as OpenRouterEmbeddingRanking[]
    : null;
  const imageModels = images as OpenRouterImageModel[];
  const embeddingModels = embeddings as OpenRouterModel[];
  const rerankModels = await enrichSpecialPricing(
    reranks as OpenRouterModel[],
    (model) => enrichRerankPricing(model, fetchFn),
  );
  const transcriptionModels = await enrichSpecialPricing(
    transcriptions as OpenRouterModel[],
    (model) => enrichTranscriptionPricing(model, fetchFn),
  );
  if (rankings !== null && leaderboardPermaslugs(models as OpenRouterModel[], rankings)?.size !== ADDITION_LEADERBOARD_LIMIT * 2) {
    rankings = null;
  }
  if (imageRankings !== null && imageLeaderboardIds(imageModels, imageRankings)?.length !== ADDITION_LEADERBOARD_LIMIT) {
    imageRankings = null;
  }
  if (embeddingRankings !== null && embeddingLeaderboardIds(embeddingModels, embeddingRankings)?.length !== ADDITION_LEADERBOARD_LIMIT) {
    embeddingRankings = null;
  }
  if (rerankRankings !== null && specializedLeaderboardIds(rerankModels, rerankRankings)?.length !== Math.min(ADDITION_LEADERBOARD_LIMIT, rerankModels.length)) {
    rerankRankings = null;
  }
  if (transcriptionRankings !== null && specializedLeaderboardIds(transcriptionModels, transcriptionRankings)?.length !== Math.min(ADDITION_LEADERBOARD_LIMIT, transcriptionModels.length)) {
    transcriptionRankings = null;
  }
  const imageLeaderboard = imageLeaderboardIds(imageModels, imageRankings) ?? [];
  const embeddingLeaderboard = embeddingLeaderboardIds(embeddingModels, embeddingRankings) ?? [];
  const rerankLeaderboard = specializedLeaderboardIds(rerankModels, rerankRankings) ?? [];
  const transcriptionLeaderboard = specializedLeaderboardIds(transcriptionModels, transcriptionRankings) ?? [];
  const listed = new Set([...idsOf(models), ...idsOf(images), ...idsOf(embeddings), ...idsOf(reranks), ...idsOf(transcriptions)]);
  const endpoints: Record<string, OpenRouterEndpoint[] | null> = {};
  const queue = [...new Set([
    ...selectEndpointIds(models as OpenRouterModel[], rankings),
    ...imageLeaderboard,
    ...embeddingLeaderboard,
    ...rerankLeaderboard,
    ...transcriptionLeaderboard,
  ])].filter((id) =>
    listed.has(id));
  await Promise.all(
    Array.from({ length: ENDPOINT_CONCURRENCY }, async () => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        try {
          const body = (await fetchJson(openRouterEndpointsUrl(id), {}, fetchFn)) as {
            data?: { endpoints?: unknown };
          };
          if (!Array.isArray(body.data?.endpoints)) {
            throw new Error("no endpoints array");
          }
          endpoints[id] = body.data.endpoints as OpenRouterEndpoint[];
        } catch {
          endpoints[id] = null;
        }
      }
    }),
  );
  return {
    models: models as OpenRouterModel[],
    imageIds: idsOf(images),
    imageModels,
    embeddingModels,
    rerankModels,
    transcriptionModels,
    endpoints,
    rankings,
    imageRankings,
    embeddingRankings,
    rerankRankings,
    transcriptionRankings,
  };
}

type TokenPricing = Pick<ModelPricing, "inputPer1M" | "outputPer1M" | "cachedInputPer1M" | "perSearch" | "perAudioMinute" | "discount">;

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

/** An embeddings route charges only for input tokens; output vectors are not tokens. */
function embeddingPricing(model: OpenRouterModel): Omit<TokenPricing, "discount"> | null {
  const prompt = Number(model.pricing?.prompt);
  if (!(prompt > 0)) {
    return null;
  }
  const cached = Number(model.pricing?.input_cache_read);
  return {
    inputPer1M: perMillion(prompt),
    outputPer1M: 0,
    ...(cached > 0 ? { cachedInputPer1M: perMillion(cached) } : {}),
  };
}

/** Rerank providers charge either input tokens or one flat search unit. */
function rerankPricing(model: OpenRouterModel): Omit<TokenPricing, "discount"> | null {
  const input = Number(model.pricing?.rerank_input);
  const search = Number(model.pricing?.rerank_search);
  if (input > 0) {
    return { inputPer1M: perMillion(input), outputPer1M: 0 };
  }
  if (search > 0) {
    return { inputPer1M: 0, outputPer1M: 0, perSearch: search };
  }
  return null;
}

/** STT is billed either like generated tokens or by input-audio minute. */
function transcriptionPricing(model: OpenRouterModel): Omit<TokenPricing, "discount"> | null {
  const input = Number(model.pricing?.transcription_input);
  const output = Number(model.pricing?.transcription_output);
  const minute = Number(model.pricing?.transcription_minute);
  if (input > 0 && output > 0) {
    return { inputPer1M: perMillion(input), outputPer1M: perMillion(output) };
  }
  if (minute > 0) {
    return { inputPer1M: 0, outputPer1M: 0, perAudioMinute: minute };
  }
  return null;
}

function standardImageEndpoint(endpoints: OpenRouterEndpoint[] | null | undefined): OpenRouterEndpoint | undefined {
  return endpoints
    ?.filter((candidate) => {
      const tier = `${candidate.tag ?? ""} ${candidate.provider_name ?? ""}`.toLowerCase();
      return Number(candidate.pricing?.image_output) > 0 && !tier.includes("flex") && !tier.includes("priority");
    })
    .sort((left, right) =>
      `${left.tag ?? ""}\0${left.provider_name ?? ""}`.localeCompare(`${right.tag ?? ""}\0${right.provider_name ?? ""}`),
    )[0];
}

function imagePricing(endpoints: OpenRouterEndpoint[] | null | undefined): ModelPricing | null {
  const endpoint = standardImageEndpoint(endpoints);
  const imageOutput = Number(endpoint?.pricing?.image_output);
  if (!(imageOutput > 0)) {
    return null;
  }
  const prompt = Number(endpoint?.pricing?.prompt);
  const completion = Number(endpoint?.pricing?.completion);
  const cached = Number(endpoint?.pricing?.input_cache_read);
  return {
    inputPer1M: prompt > 0 ? perMillion(prompt) : 0,
    outputPer1M: completion > 0 ? perMillion(completion) : 0,
    ...(cached > 0 ? { cachedInputPer1M: perMillion(cached) } : {}),
    imageOutputPer1M: perMillion(imageOutput),
  };
}

function isImageLimit(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isSpecializedWindow(value: unknown, kind: "rerank" | "transcription"): value is number {
  return kind === "transcription" ? isImageLimit(value) : isPositiveInt(value);
}

/** Prefer the aggregate cap; otherwise use the largest endpoint OpenRouter can route the request to. */
function textMaxTokens(
  model: OpenRouterModel,
  endpoints: OpenRouterEndpoint[] | null | undefined,
): number | null {
  const window = model.context_length;
  if (!isPositiveInt(window)) return null;
  const aggregate = model.top_provider?.max_completion_tokens;
  if (isPositiveInt(aggregate) && aggregate <= window) return aggregate;
  const usable = (endpoints ?? []).flatMap((endpoint) => {
    const maxOut = endpoint.max_completion_tokens;
    const endpointWindow = isPositiveInt(endpoint.context_length)
      ? Math.min(endpoint.context_length, window)
      : window;
    return isPositiveInt(maxOut) && maxOut <= endpointWindow ? [maxOut] : [];
  });
  return usable.length > 0 ? Math.max(...usable) : null;
}

function transcriptionMaxTokens(
  model: OpenRouterModel,
  endpoints: OpenRouterEndpoint[] | null | undefined,
): number | null {
  return model.context_length === 0 ? 0 : textMaxTokens(model, endpoints);
}

/** A reset may only proceed when every policy input and ranked modality model is usable. */
export function openRouterResetReady(catalog: OpenRouterCatalog): boolean {
  if (
    catalog.rankings === null
    || catalog.imageRankings === null
    || catalog.embeddingRankings === null
    || catalog.rerankRankings === null
    || catalog.transcriptionRankings === null
  ) return false;
  const ids = imageLeaderboardIds(catalog.imageModels, catalog.imageRankings);
  if (ids === null || ids.length !== ADDITION_LEADERBOARD_LIMIT) return false;
  const imagesReady = ids.every((id) => {
    const endpoint = standardImageEndpoint(catalog.endpoints[id]);
    const window = endpoint?.context_length;
    const maxOut = endpoint?.max_completion_tokens ?? window;
    return imagePricing(catalog.endpoints[id]) !== null
      && isImageLimit(window)
      && isImageLimit(maxOut)
      && maxOut <= window;
  });
  return imagesReady;
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
    ...(pricing.perSearch !== undefined ? { perSearch: pricing.perSearch } : {}),
    ...(pricing.perAudioMinute !== undefined ? { perAudioMinute: pricing.perAudioMinute } : {}),
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
  const byImageId = new Map(catalog.imageModels.map((model) => [model.id, model]));
  const byEmbeddingId = new Map(catalog.embeddingModels.map((model) => [model.id, model]));
  const byRerankId = new Map(catalog.rerankModels.map((model) => [model.id, model]));
  const byTranscriptionId = new Map(catalog.transcriptionModels.map((model) => [model.id, model]));
  const drawn = new Set(catalog.imageIds);
  const changes: Change[] = [];
  const notes: string[] = [];

  for (const offering of next.offerings) {
    if (offering.provider !== "openrouter" || offering.wireId === undefined || (offering.hidden && offering.hiddenReason !== "catalog")) {
      continue;
    }
    const id = `openrouter/${offering.family}`;
    const family = next.families[offering.family];
    if (family === undefined) {
      continue;
    }
    const entry = family.capabilities.embedding
      ? byEmbeddingId.get(offering.wireId)
      : family.capabilities.rerank
        ? byRerankId.get(offering.wireId)
        : family.capabilities.transcription
          ? byTranscriptionId.get(offering.wireId)
          : byId.get(offering.wireId);

    if (family.capabilities.imageGeneration) {
      const image = byImageId.get(offering.wireId);
      observePresence(offering, entry !== undefined || drawn.has(offering.wireId), "OpenRouter", today, changes, notes);
      if (image === undefined) {
        continue;
      }
      const routerOnly = next.offerings
        .filter((other) => other.family === offering.family)
        .every((other) => other.provider === "openrouter");
      if (!routerOnly) {
        continue;
      }
      const endpoint = standardImageEndpoint(catalog.endpoints[offering.wireId]);
      const price = imagePricing(catalog.endpoints[offering.wireId]);
      if (price !== null && !samePricing({ ...family.pricing }, { ...price })) {
        changes.push({ target: `family ${offering.family}`, field: "pricing", from: family.pricing, to: price });
        family.pricing = price;
      }
      const window = endpoint?.context_length;
      if (isImageLimit(window) && window !== family.contextWindow) {
        changes.push({ target: `family ${offering.family}`, field: "contextWindow", from: family.contextWindow, to: window });
        family.contextWindow = window;
      }
      const maxOut = isImageLimit(endpoint?.max_completion_tokens)
        ? endpoint.max_completion_tokens
        : window;
      if (isImageLimit(maxOut) && maxOut <= family.contextWindow && maxOut !== family.maxTokens) {
        changes.push({ target: `family ${offering.family}`, field: "maxTokens", from: family.maxTokens, to: maxOut });
        family.maxTokens = maxOut;
      }
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
    const routerPrice = family.capabilities.embedding
      ? embeddingPricing(entry)
      : family.capabilities.rerank
        ? rerankPricing(entry)
        : family.capabilities.transcription
          ? transcriptionPricing(entry)
          : tokenPricing(entry);
    if (routerPrice === null) {
      notes.push(`${id}: OpenRouter lists no usable price`);
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
      const kind = family.capabilities.transcription ? "transcription" : "rerank";
      if (isSpecializedWindow(window, kind) && window !== family.contextWindow) {
        changes.push({ target: `family ${offering.family}`, field: "contextWindow", from: family.contextWindow, to: window });
        family.contextWindow = window;
      }
      if (family.capabilities.transcription) {
        const maxOut = transcriptionMaxTokens(entry, catalog.endpoints[offering.wireId]);
        if (maxOut !== null && maxOut !== family.maxTokens) {
          changes.push({ target: `family ${offering.family}`, field: "maxTokens", from: family.maxTokens, to: maxOut });
          family.maxTokens = maxOut;
        }
      } else if (!family.capabilities.embedding && !family.capabilities.rerank) {
        const aggregateMaxOut = entry.top_provider?.max_completion_tokens;
        const maxOut = textMaxTokens(entry, catalog.endpoints[offering.wireId]);
        if (maxOut !== null && maxOut !== family.maxTokens) {
          changes.push({ target: `family ${offering.family}`, field: "maxTokens", from: family.maxTokens, to: maxOut });
          family.maxTokens = maxOut;
        } else if (maxOut === null && isPositiveInt(aggregateMaxOut)) {
          notes.push(`${id}: OpenRouter states max_completion_tokens ${aggregateMaxOut} above the ${family.contextWindow} window; left alone`);
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
    const kind = family.capabilities.transcription ? "transcription" : "rerank";
    if (isSpecializedWindow(window, kind) && window !== family.contextWindow) {
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

const MAJOR_MODEL_MAKERS = new Set(["openai", "anthropic", "google", "xai"]);
const ADDITION_LEADERBOARD_LIMIT = 20;
const TEXT_RETENTION_LEADERBOARD_LIMIT = 50;
const IMAGE_RETENTION_LEADERBOARD_LIMIT = 30;
const EMBEDDING_RETENTION_LEADERBOARD_LIMIT = 30;
const RERANK_RETENTION_LEADERBOARD_LIMIT = 30;
const TRANSCRIPTION_RETENTION_LEADERBOARD_LIMIT = 30;

function standardPermaslug(permaslug: string): string {
  const colon = permaslug.indexOf(":");
  return colon === -1 ? permaslug : permaslug.slice(0, colon);
}

/** The image leaderboard, ordered by image-producing requests and folded to catalog ids. */
function imageLeaderboardIds(
  models: OpenRouterImageModel[],
  rankings: OpenRouterImageRanking[] | null,
  limit = ADDITION_LEADERBOARD_LIMIT,
): string[] | null {
  if (rankings === null) {
    return null;
  }
  const totals = new Map<string, number>();
  for (const row of rankings) {
    totals.set(
      row.variant_permaslug,
      (totals.get(row.variant_permaslug) ?? 0) + row.image_output_requests,
    );
  }
  const ranked = [...totals]
    .sort((left, right) => right[1] - left[1])
    .map(([permaslug]) => standardPermaslug(permaslug));
  const ids: string[] = [];
  for (const permaslug of ranked) {
    const model = models.find(({ id }) => {
      const suffix = permaslug.slice(id.length);
      return permaslug === id || permaslug.startsWith(id) && /^-\d{8}$/.test(suffix);
    });
    if (model !== undefined && !ids.includes(model.id)) {
      ids.push(model.id);
      if (ids.length === limit) break;
    }
  }
  return ids;
}

/** The embeddings leaderboard, ordered by requests and folded to catalog ids. */
function embeddingLeaderboardIds(
  models: OpenRouterModel[],
  rankings: OpenRouterEmbeddingRanking[] | null,
  limit = ADDITION_LEADERBOARD_LIMIT,
): string[] | null {
  if (rankings === null) {
    return null;
  }
  const totals = new Map<string, number>();
  for (const row of rankings) {
    totals.set(row.variant_permaslug, (totals.get(row.variant_permaslug) ?? 0) + row.count);
  }
  const ranked = [...totals]
    .sort((left, right) => right[1] - left[1])
    .map(([permaslug]) => standardPermaslug(permaslug));
  const candidates = [...models].sort(
    (left, right) => Number(isVariant(splitId(left.id)?.slug ?? "")) - Number(isVariant(splitId(right.id)?.slug ?? "")),
  );
  const ids: string[] = [];
  for (const permaslug of ranked) {
    const model = candidates.find(({ id, canonical_slug: canonical }) => {
      const suffix = permaslug.slice(id.length);
      return permaslug === canonical || permaslug === id || permaslug.startsWith(id) && /^-\d{8}$/.test(suffix);
    });
    if (model !== undefined && !ids.includes(model.id)) {
      ids.push(model.id);
      if (ids.length === limit) break;
    }
  }
  return ids;
}

function specializedLeaderboardIds(
  models: OpenRouterModel[],
  rankings: OpenRouterEmbeddingRanking[] | null,
  limit = ADDITION_LEADERBOARD_LIMIT,
): string[] | null {
  return embeddingLeaderboardIds(models, rankings, limit);
}

/** The weekly open/closed leaderboard, with serving variants folded to one model. */
function leaderboardPermaslugs(
  models: OpenRouterModel[],
  rankings: OpenRouterRanking[] | null,
  limit = ADDITION_LEADERBOARD_LIMIT,
): Set<string> | null {
  if (rankings === null) {
    return null;
  }
  const byCanonical = new Map<string, OpenRouterModel>();
  for (const model of models) {
    if (typeof model.canonical_slug !== "string" || model.canonical_slug === "") {
      continue;
    }
    const current = byCanonical.get(model.canonical_slug);
    const parts = splitId(model.id);
    const currentParts = current === undefined ? null : splitId(current.id);
    if (current === undefined || currentParts !== null && isVariant(currentParts.slug) && parts !== null && !isVariant(parts.slug)) {
      byCanonical.set(model.canonical_slug, model);
    }
  }

  const totals = new Map<string, number>();
  for (const row of rankings) {
    totals.set(
      row.variant_permaslug,
      (totals.get(row.variant_permaslug) ?? 0) + row.total_prompt_tokens + row.total_completion_tokens,
    );
  }
  const rows = [...totals].sort((left, right) => right[1] - left[1]);
  const eligible = new Set<string>();
  let open = 0;
  let closed = 0;
  for (const [variantPermaslug] of rows) {
    const permaslug = standardPermaslug(variantPermaslug);
    const model = byCanonical.get(permaslug);
    const parts = model === undefined ? null : splitId(model.id);
    if (model === undefined || parts === null || parts.vendor === "stealth") {
      continue;
    }
    if (eligible.has(permaslug)) {
      continue;
    }
    const isOpen = typeof model.hugging_face_id === "string" && model.hugging_face_id !== "";
    if (isOpen && open < limit) {
      open += 1;
      eligible.add(permaslug);
    } else if (!isOpen && closed < limit) {
      closed += 1;
      eligible.add(permaslug);
    }
    if (open === limit && closed === limit) {
      break;
    }
  }
  return eligible;
}

/**
 * `-20250929`, `-0813`, `-2025`, `-2025-09-29`: a dated snapshot; the undated
 * alias is what a registry names. One judgment on purpose — discovery's
 * adoption gate and the endpoints-read skip must call the same listings dated,
 * or an ISO-dated slug is adopted as a family whose endpoints were never read
 * and its discount silently missing on day one.
 */
function isDated(slug: string): boolean {
  return /-(?:\d{4}|\d{8}|\d{4}-\d{2}-\d{2})$/.test(slug);
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

function makerDisplayNameOf(model: OpenRouterImageModel, vendor: string): string {
  const raw = (model.name ?? "").trim();
  return raw.includes(": ") ? raw.slice(0, raw.indexOf(": ")).trim() : vendor;
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
  const age = daysBetween(utcDate(new Date(model.created * 1000)), today);
  return age >= 0 && age <= DISCOVERY_WINDOW_DAYS;
}

function oldEnoughForRankingRetirement(created: number | undefined, today: string): boolean {
  if (typeof created !== "number" || !Number.isFinite(created)) {
    return false;
  }
  return daysBetween(utcDate(new Date(created * 1000)), today) > RANKING_RETIREMENT_MIN_AGE_DAYS;
}

function hasLiveVendorRoute(registry: Registry, family: string): boolean {
  return registry.offerings.some(
    (offering) => offering.family === family && offering.provider !== "openrouter" && !offering.hidden,
  );
}

function isEligibleModel(
  maker: string,
  model: OpenRouterModel,
  rankedPermaslugs: Set<string> | null,
): boolean {
  return MAJOR_MODEL_MAKERS.has(maker)
    || typeof model.canonical_slug === "string" && rankedPermaslugs?.has(model.canonical_slug) === true;
}

function imageCapabilitiesOf(model: OpenRouterImageModel): ModelCapabilities {
  return {
    tools: false,
    structuredOutput: false,
    imageInput: (model.architecture?.input_modalities ?? []).includes("image"),
    reasoning: false,
    imageGeneration: true,
  };
}

function embeddingCapabilitiesOf(model: OpenRouterModel): ModelCapabilities {
  return {
    tools: false,
    structuredOutput: false,
    imageInput: (model.architecture?.input_modalities ?? []).includes("image"),
    reasoning: false,
    embedding: true,
  };
}

function specializedCapabilitiesOf(model: OpenRouterModel, kind: "rerank" | "transcription"): ModelCapabilities {
  const base = {
    tools: false,
    structuredOutput: false,
    imageInput: (model.architecture?.input_modalities ?? []).includes("image"),
    reasoning: false,
  };
  return kind === "rerank" ? { ...base, rerank: true } : { ...base, transcription: true };
}

function discoverRankedImages(
  registry: Registry,
  catalog: OpenRouterCatalog,
  today: string,
  changes: Change[],
  notes: string[],
  makerOfVendor: Map<string, string>,
  routed: Set<string | undefined>,
): void {
  const rankedIds = imageLeaderboardIds(catalog.imageModels, catalog.imageRankings);
  if (rankedIds === null) {
    notes.push("openrouter: weekly image rankings could not be read; image models and routes were not added");
    return;
  }
  const byId = new Map(catalog.imageModels.map((model) => [model.id, model]));
  for (const id of rankedIds) {
    if (routed.has(id)) {
      continue;
    }
    const model = byId.get(id);
    const parts = splitId(id);
    if (model === undefined || parts === null) {
      continue;
    }
    const { vendor, slug } = parts;
    let maker = makerOfVendor.get(vendor);
    const family = registry.families[slug];
    if (family !== undefined) {
      if (maker === undefined || family.maker !== maker) {
        notes.push(`openrouter: ranked image ${id} names family "${slug}" under another maker; left alone`);
        continue;
      }
      if (!family.capabilities.imageGeneration || !familyIsLive(registry, slug)) {
        continue;
      }
      if (addRoute(registry, { provider: "openrouter", family: slug, wireId: id }, changes)) {
        routed.add(id);
      }
      continue;
    }

    if (!isSafeSlug(slug)) {
      notes.push(`openrouter: ranked image ${id} cannot be a family id; add it by hand under a name this registry can use`);
      continue;
    }
    const endpoints = catalog.endpoints[id];
    const endpoint = standardImageEndpoint(endpoints);
    const price = imagePricing(endpoints);
    const window = endpoint?.context_length;
    if (price === null || !isImageLimit(window)) {
      notes.push(`openrouter: ranked image ${id} has no usable endpoint price or context window; left alone`);
      continue;
    }
    const endpointMax = endpoint?.max_completion_tokens;
    const maxOut = isImageLimit(endpointMax)
      ? endpointMax
      : window;
    if (maxOut > window) {
      notes.push(`openrouter: ranked image ${id} states max output ${maxOut} above its ${window} window; left alone`);
      continue;
    }
    if (maker === undefined) {
      if (!isSafeSlug(vendor)) {
        notes.push(`openrouter: ranked image ${id} comes from vendor "${vendor}", which cannot be a maker id; add the maker by hand`);
        continue;
      }
      maker = vendor;
      registry.makers[maker] = {
        displayName: makerDisplayNameOf(model, vendor),
        openrouterVendor: vendor,
      };
      makerOfVendor.set(vendor, maker);
      changes.push({
        target: `maker ${maker}`,
        field: "added",
        from: undefined,
        to: registry.makers[maker]!.displayName,
      });
    }
    const created: ModelFamily & { maker: string } = {
      maker,
      displayName: displayNameOf(model, slug),
      pricing: price,
      capabilities: imageCapabilitiesOf(model),
      contextWindow: window,
      maxTokens: maxOut,
      note: `Added automatically on ${today} from OpenRouter's weekly image top 20; numbers and flags are OpenRouter's.`,
    };
    registry.families[slug] = created;
    registry.offerings.push({ provider: "openrouter", family: slug, wireId: id });
    routed.add(id);
    changes.push({
      target: `family ${slug}`,
      field: "added",
      from: undefined,
      to: `${created.displayName} via openrouter (${id})`,
    });
  }
}

function discoverRankedEmbeddings(
  registry: Registry,
  catalog: OpenRouterCatalog,
  today: string,
  changes: Change[],
  notes: string[],
  makerOfVendor: Map<string, string>,
  routed: Set<string | undefined>,
): void {
  const rankedIds = embeddingLeaderboardIds(catalog.embeddingModels, catalog.embeddingRankings);
  if (rankedIds === null) {
    notes.push("openrouter: weekly embeddings rankings could not be read; embedding models and routes were not added");
    return;
  }
  const byId = new Map(catalog.embeddingModels.map((model) => [model.id, model]));
  for (const id of rankedIds) {
    if (routed.has(id)) {
      continue;
    }
    const model = byId.get(id);
    const parts = splitId(id);
    if (model === undefined || parts === null || isVariant(parts.slug)) {
      continue;
    }
    const { vendor, slug } = parts;
    let maker = makerOfVendor.get(vendor);
    const family = registry.families[slug];
    if (family !== undefined) {
      if (maker === undefined || family.maker !== maker) {
        notes.push(`openrouter: ranked embedding ${id} names family "${slug}" under another maker; left alone`);
        continue;
      }
      if (!family.capabilities.embedding || !familyIsLive(registry, slug)) {
        continue;
      }
      if (addRoute(registry, { provider: "openrouter", family: slug, wireId: id }, changes)) {
        routed.add(id);
      }
      continue;
    }

    if (!isSafeSlug(slug)) {
      notes.push(`openrouter: ranked embedding ${id} cannot be a family id; add it by hand under a name this registry can use`);
      continue;
    }
    const price = embeddingPricing(model);
    const window = model.context_length;
    if (price === null || !isPositiveInt(window)) {
      notes.push(`openrouter: ranked embedding ${id} has no usable input price or context window; left alone`);
      continue;
    }
    if (maker === undefined) {
      if (!isSafeSlug(vendor)) {
        notes.push(`openrouter: ranked embedding ${id} comes from vendor "${vendor}", which cannot be a maker id; add the maker by hand`);
        continue;
      }
      maker = vendor;
      registry.makers[maker] = {
        displayName: makerDisplayNameOf(model, vendor),
        openrouterVendor: vendor,
      };
      makerOfVendor.set(vendor, maker);
      changes.push({
        target: `maker ${maker}`,
        field: "added",
        from: undefined,
        to: registry.makers[maker]!.displayName,
      });
    }
    const discount = catalogDiscount(model, catalog.endpoints[id]);
    const created: ModelFamily & { maker: string } = {
      maker,
      displayName: displayNameOf(model, slug),
      pricing: { ...price, ...(typeof discount === "number" ? { discount } : {}) },
      capabilities: embeddingCapabilitiesOf(model),
      contextWindow: window,
      maxTokens: 0,
      note: `Added automatically on ${today} from OpenRouter's weekly embeddings top 20; numbers and flags are OpenRouter's.`,
    };
    registry.families[slug] = created;
    registry.offerings.push({ provider: "openrouter", family: slug, wireId: id });
    routed.add(id);
    changes.push({
      target: `family ${slug}`,
      field: "added",
      from: undefined,
      to: `${created.displayName} via openrouter (${id})`,
    });
  }
}

function discoverRankedSpecialized(
  registry: Registry,
  catalog: OpenRouterCatalog,
  today: string,
  kind: "rerank" | "transcription",
  changes: Change[],
  notes: string[],
  makerOfVendor: Map<string, string>,
  routed: Set<string | undefined>,
): void {
  const models = kind === "rerank" ? catalog.rerankModels : catalog.transcriptionModels;
  const rankings = kind === "rerank" ? catalog.rerankRankings : catalog.transcriptionRankings;
  const rankedIds = specializedLeaderboardIds(models, rankings);
  if (rankedIds === null) {
    notes.push(`openrouter: weekly ${kind} rankings could not be read; ${kind} models and routes were not added`);
    return;
  }
  const byId = new Map(models.map((model) => [model.id, model]));
  for (const id of rankedIds) {
    if (routed.has(id)) {
      continue;
    }
    const model = byId.get(id);
    const parts = splitId(id);
    if (model === undefined || parts === null || isVariant(parts.slug)) {
      continue;
    }
    const { vendor, slug } = parts;
    let maker = makerOfVendor.get(vendor);
    const family = registry.families[slug];
    if (family !== undefined) {
      if (maker === undefined || family.maker !== maker) {
        notes.push(`openrouter: ranked ${kind} ${id} names family "${slug}" under another maker; left alone`);
        continue;
      }
      if (!family.capabilities[kind] || !familyIsLive(registry, slug)) {
        continue;
      }
      if (addRoute(registry, { provider: "openrouter", family: slug, wireId: id }, changes)) {
        routed.add(id);
      }
      continue;
    }

    if (!isSafeSlug(slug)) {
      notes.push(`openrouter: ranked ${kind} ${id} cannot be a family id; add it by hand under a name this registry can use`);
      continue;
    }
    const price = kind === "rerank" ? rerankPricing(model) : transcriptionPricing(model);
    const window = model.context_length;
    const maxOut = kind === "rerank" ? 0 : transcriptionMaxTokens(model, catalog.endpoints[id]);
    if (price === null || !isSpecializedWindow(window, kind) || maxOut === null) {
      notes.push(`openrouter: ranked ${kind} ${id} has no usable price or limits; left alone`);
      continue;
    }
    if (maker === undefined) {
      if (!isSafeSlug(vendor)) {
        notes.push(`openrouter: ranked ${kind} ${id} comes from vendor "${vendor}", which cannot be a maker id; add the maker by hand`);
        continue;
      }
      maker = vendor;
      registry.makers[maker] = {
        displayName: makerDisplayNameOf(model, vendor),
        openrouterVendor: vendor,
      };
      makerOfVendor.set(vendor, maker);
      changes.push({
        target: `maker ${maker}`,
        field: "added",
        from: undefined,
        to: registry.makers[maker]!.displayName,
      });
    }
    const discount = catalogDiscount(model, catalog.endpoints[id]);
    const created: ModelFamily & { maker: string } = {
      maker,
      displayName: displayNameOf(model, slug),
      pricing: { ...price, ...(typeof discount === "number" ? { discount } : {}) },
      capabilities: specializedCapabilitiesOf(model, kind),
      contextWindow: window,
      maxTokens: maxOut,
      note: `Added automatically on ${today} from OpenRouter's weekly ${kind} top 20; numbers and flags are OpenRouter's.`,
    };
    registry.families[slug] = created;
    registry.offerings.push({ provider: "openrouter", family: slug, wireId: id });
    routed.add(id);
    changes.push({
      target: `family ${slug}`,
      field: "added",
      from: undefined,
      to: `${created.displayName} via openrouter (${id})`,
    });
  }
}

/** Hide every live OpenRouter route without deleting any published id or family. */
export function resetOpenRouterRegistry(registry: Registry): {
  registry: Registry;
  deactivatedOfferings: number;
} {
  const next = structuredClone(registry);
  let deactivatedOfferings = 0;
  for (const offering of next.offerings) {
    if (offering.provider === "openrouter" && !offering.hidden) {
      offering.hidden = true;
      offering.hiddenReason = "reset";
      delete offering.missingSince;
      delete offering.missingObservations;
      delete offering.lastMissingAt;
      delete offering.rankMissingSince;
      delete offering.rankMissingObservations;
      delete offering.lastRankMissingAt;
      deactivatedOfferings += 1;
    }
  }
  return { registry: next, deactivatedOfferings };
}

/**
 * The ids whose endpoints discovery will want read — the known makers' recent
 * listings (a new family) and their listings named after a family this
 * registry has (a new route) — so either carries its discount from the first
 * day rather than the second.
 */
export function discoveryEndpointIds(
  registry: Registry,
  models: OpenRouterModel[],
  today: string,
  rankings: OpenRouterRanking[] | null = null,
  options: OpenRouterDiscoveryOptions = {},
): string[] {
  const makerOfVendor = new Map(
    Object.entries(registry.makers).flatMap(([maker, definition]) =>
      definition.openrouterVendor === undefined ? [] : [[definition.openrouterVendor, maker]]),
  );
  const rankedPermaslugs = leaderboardPermaslugs(models, rankings);
  return models
    .filter((model) => {
      const parts = splitId(model.id);
      const maker = parts === null ? undefined : makerOfVendor.get(parts.vendor);
      if (parts === null || maker === undefined || isVariant(parts.slug)) {
        return false;
      }
      // A dated snapshot is skipped by discovery either way — reading its
      // endpoints first is a wasted request per snapshot per day.
      if (isDated(parts.slug)) {
        return false;
      }
      if (!isEligibleModel(maker, model, rankedPermaslugs)) {
        return false;
      }
      const ranked = typeof model.canonical_slug === "string" && rankedPermaslugs?.has(model.canonical_slug) === true;
      return options.bootstrap === true || ranked || isRecent(model, today) || registry.families[parts.slug] !== undefined;
    })
    .map((model) => model.id);
}

export function discoverOpenRouter(
  registry: Registry,
  catalog: OpenRouterCatalog,
  today: string,
  options: OpenRouterDiscoveryOptions = {},
): { registry: Registry; result: SourceResult } {
  const next = structuredClone(registry);
  const changes: Change[] = [];
  const notes: string[] = [];
  const makerOfVendor = new Map(
    Object.entries(next.makers).flatMap(([maker, definition]) =>
      definition.openrouterVendor === undefined ? [] : [[definition.openrouterVendor, maker]]),
  );
  const unknownVendors = new Map<string, string[]>();
  const rankedPermaslugs = leaderboardPermaslugs(catalog.models, catalog.rankings);
  const textRetention = leaderboardPermaslugs(
    catalog.models,
    catalog.rankings,
    TEXT_RETENTION_LEADERBOARD_LIMIT,
  );
  const retainedPermaslugs = textRetention?.size === TEXT_RETENTION_LEADERBOARD_LIMIT * 2
    ? textRetention
    : null;
  if (rankedPermaslugs === null) {
    notes.push("openrouter: weekly rankings could not be read; non-major models and routes were not added");
  } else if (retainedPermaslugs === null) {
    notes.push("openrouter: weekly rankings did not contain a complete open/closed Top 50; ranking retirement did not advance");
  }
  const rankedImageIds = imageLeaderboardIds(catalog.imageModels, catalog.imageRankings);
  const imageRetention = imageLeaderboardIds(
    catalog.imageModels,
    catalog.imageRankings,
    IMAGE_RETENTION_LEADERBOARD_LIMIT,
  );
  const retainedImageIds = imageRetention?.length === IMAGE_RETENTION_LEADERBOARD_LIMIT
    ? new Set(imageRetention)
    : null;
  if (rankedImageIds !== null && retainedImageIds === null) {
    notes.push("openrouter: weekly image rankings did not contain a complete Top 30; ranking retirement did not advance");
  }
  const rankedEmbeddingIds = embeddingLeaderboardIds(catalog.embeddingModels, catalog.embeddingRankings);
  const embeddingRetention = embeddingLeaderboardIds(
    catalog.embeddingModels,
    catalog.embeddingRankings,
    EMBEDDING_RETENTION_LEADERBOARD_LIMIT,
  );
  const retainedEmbeddingIds = embeddingRetention?.length === EMBEDDING_RETENTION_LEADERBOARD_LIMIT
    ? new Set(embeddingRetention)
    : null;
  if (rankedEmbeddingIds !== null && retainedEmbeddingIds === null) {
    notes.push("openrouter: weekly embeddings rankings did not contain a complete Top 30; ranking retirement did not advance");
  }
  const rerankRetention = specializedLeaderboardIds(
    catalog.rerankModels,
    catalog.rerankRankings,
    RERANK_RETENTION_LEADERBOARD_LIMIT,
  );
  const retainedRerankIds = rerankRetention?.length === Math.min(RERANK_RETENTION_LEADERBOARD_LIMIT, catalog.rerankModels.length)
    ? new Set(rerankRetention)
    : null;
  if (catalog.rerankRankings !== null && retainedRerankIds === null) {
    notes.push("openrouter: weekly rerank rankings were incomplete; ranking retirement did not advance");
  }
  const transcriptionRetention = specializedLeaderboardIds(
    catalog.transcriptionModels,
    catalog.transcriptionRankings,
    TRANSCRIPTION_RETENTION_LEADERBOARD_LIMIT,
  );
  const retainedTranscriptionIds = transcriptionRetention?.length === Math.min(TRANSCRIPTION_RETENTION_LEADERBOARD_LIMIT, catalog.transcriptionModels.length)
    ? new Set(transcriptionRetention)
    : null;
  if (catalog.transcriptionRankings !== null && retainedTranscriptionIds === null) {
    notes.push("openrouter: weekly transcription rankings were incomplete; ranking retirement did not advance");
  }
  const textById = new Map(catalog.models.map((model) => [model.id, model]));
  const imageById = new Map(catalog.imageModels.map((model) => [model.id, model]));
  const embeddingById = new Map(catalog.embeddingModels.map((model) => [model.id, model]));
  const rerankById = new Map(catalog.rerankModels.map((model) => [model.id, model]));
  const transcriptionById = new Map(catalog.transcriptionModels.map((model) => [model.id, model]));
  for (const offering of next.offerings) {
    if (offering.provider !== "openrouter" || offering.wireId === undefined) continue;
    const family = next.families[offering.family];
    if (family?.capabilities.imageGeneration) {
      if (retainedImageIds !== null) {
        const model = imageById.get(offering.wireId);
        const eligible = model === undefined
          || !oldEnoughForRankingRetirement(model.created, today)
          || retainedImageIds.has(offering.wireId);
        observeRankingEligibility(offering, eligible, today, changes, notes);
      }
      continue;
    }
    if (family?.capabilities.embedding) {
      if (retainedEmbeddingIds !== null) {
        const model = embeddingById.get(offering.wireId);
        const eligible = model === undefined
          || !oldEnoughForRankingRetirement(model.created, today)
          || retainedEmbeddingIds.has(offering.wireId);
        observeRankingEligibility(offering, eligible, today, changes, notes);
      }
      continue;
    }
    if (family?.capabilities.rerank) {
      if (retainedRerankIds !== null) {
        const model = rerankById.get(offering.wireId);
        const eligible = model === undefined
          || !oldEnoughForRankingRetirement(model.created, today)
          || retainedRerankIds.has(offering.wireId);
        observeRankingEligibility(offering, eligible, today, changes, notes);
      }
      continue;
    }
    if (family?.capabilities.transcription) {
      if (retainedTranscriptionIds !== null) {
        const model = transcriptionById.get(offering.wireId);
        const eligible = model === undefined
          || !oldEnoughForRankingRetirement(model.created, today)
          || retainedTranscriptionIds.has(offering.wireId);
        observeRankingEligibility(offering, eligible, today, changes, notes);
      }
      continue;
    }
    if (family !== undefined && MAJOR_MODEL_MAKERS.has(family.maker) && hasLiveVendorRoute(next, offering.family)) {
      const eligible = offering.hiddenReason !== "reset" || textById.has(offering.wireId);
      observeRankingEligibility(offering, eligible, today, changes, notes);
      continue;
    }
    if (retainedPermaslugs !== null) {
      const model = textById.get(offering.wireId);
      const eligible = model === undefined
        || !oldEnoughForRankingRetirement(model.created, today)
        || typeof model.canonical_slug === "string" && retainedPermaslugs.has(model.canonical_slug);
      observeRankingEligibility(offering, eligible, today, changes, notes);
    }
  }

  // Ids this registry already routes to, whatever family name it files them
  // under — `upstage/solar-pro4` is `solar-pro-4` here, not a second family.
  const routed = new Set(next.offerings.filter((o) => o.provider === "openrouter").map((o) => o.wireId));
  discoverRankedImages(next, catalog, today, changes, notes, makerOfVendor, routed);
  discoverRankedEmbeddings(next, catalog, today, changes, notes, makerOfVendor, routed);
  discoverRankedSpecialized(next, catalog, today, "rerank", changes, notes, makerOfVendor, routed);
  discoverRankedSpecialized(next, catalog, today, "transcription", changes, notes, makerOfVendor, routed);

  for (const model of catalog.models) {
    const parts = splitId(model.id);
    if (parts === null || isVariant(parts.slug) || routed.has(model.id) || outputs(model, "image") || !outputs(model, "text")) {
      continue;
    }
    const { vendor, slug } = parts;
    const maker = makerOfVendor.get(vendor);
    const leaderboardEligible = typeof model.canonical_slug === "string" && rankedPermaslugs?.has(model.canonical_slug) === true;
    const withinDiscoveryWindow = options.bootstrap === true || leaderboardEligible || isRecent(model, today);

    if (maker === undefined) {
      if (leaderboardEligible && withinDiscoveryWindow && !isDated(slug) && tokenPricing(model) !== null) {
        unknownVendors.set(vendor, [...(unknownVendors.get(vendor) ?? []), slug]);
      }
      continue;
    }
    if (!isEligibleModel(maker, model, rankedPermaslugs)) {
      continue;
    }

    const family = next.families[slug];
    if (family !== undefined) {
      if (family.maker !== maker) {
        notes.push(`openrouter: ${model.id} names family "${slug}", which this registry files under ${family.maker}; left alone`);
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
    if (!withinDiscoveryWindow || isDated(slug)) {
      continue;
    }
    if (!isSafeSlug(slug)) {
      notes.push(`openrouter: new model ${model.id} cannot be a family id; add it by hand under a name this registry can use`);
      continue;
    }
    const price = tokenPricing(model);
    if (price === null) {
      continue;
    }
    const window = model.context_length;
    if (!isPositiveInt(window)) {
      notes.push(`openrouter: new model ${model.id} states no context window; add it by hand`);
      continue;
    }
    const maxOut = textMaxTokens(model, catalog.endpoints[model.id]);
    if (maxOut === null) {
      notes.push(`openrouter: new model ${model.id} states no usable max output (${model.top_provider?.max_completion_tokens ?? "none"} against a ${window} window); add it by hand`);
      continue;
    }
    const discount = catalogDiscount(model, catalog.endpoints[model.id]);
    const listed = typeof model.created === "number" && Number.isFinite(model.created)
      ? ` (listed ${utcDate(new Date(model.created * 1000))})`
      : "";
    const created: ModelFamily & { maker: string } = {
      maker,
      displayName: displayNameOf(model, slug),
      pricing: { ...price, ...(typeof discount === "number" ? { discount } : {}) },
      capabilities: capabilitiesOf(model),
      contextWindow: window,
      maxTokens: maxOut,
      note: `Added automatically on ${today} from OpenRouter's catalog${listed}; numbers and flags are OpenRouter's.`,
    };
    next.families[slug] = created;
    next.offerings.push({ provider: "openrouter", family: slug, wireId: model.id });
    changes.push({ target: `family ${slug}`, field: "added", from: undefined, to: `${created.displayName} via openrouter (${model.id})` });
  }

  for (const [vendor, slugs] of [...unknownVendors].sort()) {
    notes.push(
      `openrouter: ${slugs.length} eligible model${slugs.length === 1 ? "" : "s"} from "${vendor}", not a known maker (${slugs.slice(0, 6).join(", ")}${slugs.length > 6 ? ", …" : ""}) — add the maker and its OpenRouter vendor to makers.json to adopt them`,
    );
  }

  return { registry: next, result: { source: "OpenRouter", changes, notes } };
}
