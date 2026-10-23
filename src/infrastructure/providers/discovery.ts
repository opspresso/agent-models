import type { Catalog, ModelCapabilities, ModelConfig } from "../../domain/catalog/registry.ts";
import { RouterError } from "../../domain/router/errors.ts";
import type { ModelDiscovery } from "../../domain/router/transport.ts";
import type { DiscoveredModel, ModelType, Pricing, StoredProvider } from "../../domain/router/types.ts";
import { providerUrl, validIdentifier } from "../../domain/router/validation.ts";

const MAX_CATALOG_BYTES = 16 * 1024 * 1024;
const MAX_MODELS = 10_000;
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const text = (value: unknown) => typeof value === "string" && value.trim() ? value : undefined;
const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

export function catalogModelType(capabilities: ModelCapabilities): ModelType {
  if (capabilities.imageGeneration) return "image";
  if (capabilities.embedding) return "embedding";
  if (capabilities.rerank) return "rerank";
  if (capabilities.transcription) return "transcription";
  if (capabilities.decision) return "decision";
  return "text";
}

function facts(provider: StoredProvider, raw: Record<string, unknown>, known: ModelConfig | undefined, wireId: string, observedAt: string, declaredType?: ModelType): DiscoveredModel {
  const model: DiscoveredModel = { providerId: provider.id, wireId, displayName: text(raw.displayName) ?? text(raw.display_name) ?? text(raw.name) ?? known?.displayName ?? wireId,
    available: true, observedAt,
    ...(known ? { type: catalogModelType(known.capabilities), contextWindow: known.contextWindow, maxTokens: known.maxTokens,
      pricing: known.pricing, capabilities: known.capabilities, catalogId: known.id, maker: known.maker, family: known.family } : {}),
  };
  // Native limits supersede a published snapshot; absence does not invent capabilities or prices.
  const context = count(raw.inputTokenLimit) ?? count(raw.context_length) ?? count(raw.context_window) ?? count(raw.max_input_tokens);
  const output = count(raw.outputTokenLimit) ?? count(raw.max_tokens) ?? count(object(raw.top_provider)?.max_completion_tokens);
  if (context !== undefined) model.contextWindow = context;
  if (output !== undefined) model.maxTokens = output;
  if (provider.kind === "google" && Array.isArray(raw.supportedGenerationMethods)) {
    if (raw.supportedGenerationMethods.includes("embedContent")) { model.type = "embedding"; model.maxTokens = 0; }
    else if (raw.supportedGenerationMethods.includes("generateContent") && !model.type) model.type = "text";
  }
  if (provider.kind === "openrouter") {
    const architecture = object(raw.architecture);
    const modalities = architecture?.output_modalities;
    if (Array.isArray(modalities)) {
      if (modalities.includes("image")) model.type = "image";
      else if (modalities.includes("embeddings")) { model.type = "embedding"; model.maxTokens = 0; }
      else if (modalities.includes("rerank")) { model.type = "rerank"; model.maxTokens = 0; }
      else if (modalities.includes("decisions")) model.type = "decision";
      else if (modalities.includes("transcription")) model.type = "transcription";
      else if (modalities.includes("text") && !model.type) model.type = "text";
    }
    if (declaredType) {
      model.type = declaredType;
      if (declaredType === "embedding" || declaredType === "rerank") model.maxTokens = 0;
    }
    if (Array.isArray(raw.supported_parameters)) {
      const supports = raw.supported_parameters;
      model.capabilities = { ...model.capabilities, tools: supports.includes("tools"), structuredOutput: supports.includes("structured_outputs"),
        imageInput: Array.isArray(architecture?.input_modalities) && architecture.input_modalities.includes("image"), reasoning: supports.includes("reasoning") };
    }
    const prices = object(raw.pricing);
    const rate = (value: unknown) => typeof value === "string" && /^\d+(?:\.\d+)?(?:e-?\d+)?$/i.test(value) && Number.isFinite(Number(value)) ? Number(value) : undefined;
    const input = rate(prices?.prompt), outputPrice = rate(prices?.completion);
    if (input !== undefined && outputPrice !== undefined) {
      const pricing: Pricing = { inputPer1M: input * 1e6, outputPer1M: outputPrice * 1e6 };
      const cached = rate(prices?.input_cache_read);
      const written = rate(prices?.input_cache_write);
      if (cached !== undefined) pricing.cachedInputPer1M = cached * 1e6;
      if (written !== undefined) pricing.cacheWriteInputPer1M = written * 1e6;
      // Specialized zero-token SKUs need their published duration/search/image rates.
      if (model.type === "text" || model.type === "embedding" || model.type === "decision") model.pricing = pricing;
    }
  }
  return model;
}

async function readCatalogResponse(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new RouterError("provider_discovery_failed", 502, `Provider model listing failed with HTTP ${response.status}`);
  }
  if (!response.body) throw new RouterError("invalid_catalog", 502, "Provider returned an empty model catalog response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let ended = false;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) { ended = true; break; }
      bytes += chunk.value.byteLength;
      if (bytes > MAX_CATALOG_BYTES) throw new RouterError("catalog_too_large", 502, "Provider model listing exceeds its size limit");
      chunks.push(chunk.value);
    }
  } finally {
    try { if (!ended) await reader.cancel(); }
    finally { reader.releaseLock(); }
  }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new RouterError("invalid_catalog", 502, "Provider returned invalid model catalog JSON"); }
  const result = object(value);
  if (!result) throw new RouterError("invalid_catalog", 502, "Provider returned an invalid model catalog");
  return result;
}

export function createModelDiscovery(options: { catalog: () => Catalog; now?: () => Date; request?: typeof fetch; signedRequest?: typeof fetch }): ModelDiscovery {
  return {
    async discover(provider, secret) {
      const request = provider.auth === "sigv4" ? options.signedRequest : options.request ?? fetch;
      if (!request) throw new RouterError("signing_unavailable", 503, "AWS request signing is not configured");
      const configuredBase = providerUrl(provider.baseUrl);
      const base = provider.kind === "google" ? configuredBase.replace(/\/openai$/, "") : configuredBase;
      const headers = new Headers();
      if (provider.kind === "anthropic") headers.set("anthropic-version", "2023-06-01");
      if (provider.auth === "secret") {
        if (!secret) throw new RouterError("credential_required", 503, "Provider credential is unavailable");
        headers.set(provider.kind === "anthropic" ? "x-api-key" : provider.kind === "google" ? "x-goog-api-key" : "authorization",
          ["anthropic", "google"].includes(provider.kind) ? secret : `Bearer ${secret}`);
      }
      const known = new Map(options.catalog().models.filter(model => model.provider === provider.kind).map(model => [model.wireId ?? model.family, model]));
      const observedAt = (options.now?.() ?? new Date()).toISOString();
      const signal = AbortSignal.timeout(30_000);
      const sources: Array<{ path: string; type?: ModelType }> = provider.kind === "openrouter" ? [
        { path: "models" }, { path: "images/models", type: "image" }, { path: "embeddings/models", type: "embedding" },
        { path: "models?output_modalities=rerank", type: "rerank" }, { path: "models?output_modalities=transcription", type: "transcription" },
        { path: "models?output_modalities=decisions", type: "decision" },
      ] : [{ path: "models" }];
      const batches = await Promise.all(sources.map(async source => {
        const collected: DiscoveredModel[] = [];
        const seen = new Set<string>();
        const cursors = new Set<string>();
        let cursor: string | undefined;
        for (let page = 0; page < 100; page++) {
          const url = new URL(`${base}/${source.path}`);
          if (cursor) url.searchParams.set(provider.kind === "google" ? "pageToken" : "after_id", cursor);
          let response: Response;
          try { response = await request(url, { headers, signal, redirect: "error" }); }
          catch { throw new RouterError("provider_discovery_failed", 502, "Provider model listing could not be reached"); }
          const body = await readCatalogResponse(response);
          const models = provider.kind === "google" ? body.models : body.data;
          if (!Array.isArray(models)) throw new RouterError("invalid_catalog", 502, "Provider model listing is missing its model array");
          for (const raw of models) {
            const model = object(raw);
            const wireId = text(provider.kind === "google" ? model?.name : model?.id);
            if (!model || !wireId || !validIdentifier(wireId) || seen.has(wireId) || collected.length >= MAX_MODELS) throw new RouterError("invalid_catalog", 502, "Provider returned duplicate or invalid model IDs");
            seen.add(wireId);
            collected.push(facts(provider, model, known.get(wireId) ?? known.get(wireId.replace(/^models\//, "")), wireId, observedAt, source.type));
          }
          cursor = provider.kind === "google" ? text(body.nextPageToken) : body.has_more === true ? text(body.last_id) : undefined;
          if (body.has_more === true && !cursor) throw new RouterError("invalid_catalog", 502, "Provider model listing has an invalid continuation");
          if (!cursor) return collected;
          if (cursors.has(cursor) || cursor.length > 1000) throw new RouterError("invalid_catalog", 502, "Provider model listing repeated its continuation");
          cursors.add(cursor);
        }
        throw new RouterError("catalog_too_large", 502, "Provider model listing exceeded its page limit");
      }));
      const result = new Map<string, DiscoveredModel>();
      for (const batch of batches) for (const model of batch) {
        const previous = result.get(model.wireId);
        if (previous?.type && model.type && previous.type !== "text" && previous.type !== model.type) throw new RouterError("invalid_catalog", 502, "Provider model catalogs disagree on a model type");
        result.set(model.wireId, model);
        if (result.size > MAX_MODELS) throw new RouterError("catalog_too_large", 502, "Provider model catalog exceeds its model limit");
      }
      return [...result.values()];
    },
  };
}
