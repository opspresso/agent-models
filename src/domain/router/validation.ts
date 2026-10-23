import { RouterError } from "./errors.ts";
import { MODEL_TYPES, OPERATIONS, PROVIDER_KINDS, type ModelFacts, type Operation, type Provider, type SelectedModel } from "./types.ts";

export function validIdentifier(value: string): boolean {
  return value.length > 0 && value.length <= 200 && value === value.trim() && !/[\x00-\x20\x7f]/.test(value);
}

export function providerUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new RouterError("invalid_provider_url", 400, "Provider URL must be an absolute HTTP(S) URL"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new RouterError("invalid_provider_url", 400, "Provider URL must not contain credentials, query parameters or a fragment");
  }
  return url.href.replace(/\/+$/, "");
}

export function validateProvider(provider: Omit<Provider, "revision" | "updatedAt">): void {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(provider.id)) throw new RouterError("invalid_provider", 400, "Invalid provider ID");
  if (!provider.name.trim() || provider.name.length > 200 || !PROVIDER_KINDS.includes(provider.kind) ||
      !["secret", "none", "sigv4"].includes(provider.auth) || typeof provider.enabled !== "boolean") {
    throw new RouterError("invalid_provider", 400, "Invalid provider configuration");
  }
  providerUrl(provider.baseUrl);
  if (provider.auth === "sigv4" && provider.kind !== "bedrock") throw new RouterError("invalid_provider", 400, "SigV4 requires a Bedrock provider");
}

const operationTypes: Record<Operation, readonly ModelFacts["type"][]> = {
  "chat/completions": ["text", "image"], responses: ["text", "image"], messages: ["text"], "messages/count_tokens": ["text"],
  embeddings: ["embedding"], images: ["image"], "images/generations": ["image"], "images/edits": ["image"], "audio/transcriptions": ["transcription"],
  rerank: ["rerank"], decisions: ["decision"], generateContent: ["text", "image", "transcription"], streamGenerateContent: ["text", "image"],
};

export function operationsForType(type: ModelFacts["type"]): Operation[] { return OPERATIONS.filter(operation => operationTypes[operation].includes(type)); }

export function validateModel(model: ModelFacts): void {
  if (!validIdentifier(model.wireId) || !model.displayName.trim() || model.displayName.length > 200 || !MODEL_TYPES.includes(model.type)) {
    throw new RouterError("invalid_model", 400, "Invalid model identity or type");
  }
  if (![model.contextWindow, model.maxTokens].every(value => Number.isSafeInteger(value) && value >= 0) || model.maxTokens > model.contextWindow) {
    throw new RouterError("invalid_model", 400, "Invalid model token limits");
  }
  if (["text", "embedding", "rerank", "decision"].includes(model.type) && model.contextWindow === 0) {
    throw new RouterError("invalid_model", 400, "This model type requires a context window");
  }
  if (["embedding", "rerank"].includes(model.type) && model.maxTokens !== 0) throw new RouterError("invalid_model", 400, "Embedding and rerank models have no generated-token limit");
  if (!model.capabilities || ["tools", "structuredOutput", "imageInput", "reasoning"].some(key => typeof model.capabilities[key as keyof typeof model.capabilities] !== "boolean")) {
    throw new RouterError("invalid_model", 400, "Invalid model capabilities");
  }
  for (const [flag, type] of [["imageGeneration", "image"], ["embedding", "embedding"], ["rerank", "rerank"], ["transcription", "transcription"], ["decision", "decision"]] as const) {
    if (model.capabilities[flag] !== undefined && model.capabilities[flag] !== (model.type === type)) throw new RouterError("invalid_model", 400, "Model capability type disagrees with its selected type");
  }
  if (model.pricing !== null) {
    if (typeof model.pricing.inputPer1M !== "number" || typeof model.pricing.outputPer1M !== "number" ||
        Object.values(model.pricing).some(value => typeof value !== "number" || !Number.isFinite(value) || value < 0) ||
        (model.pricing.cachedInputPer1M ?? 0) > model.pricing.inputPer1M ||
        (model.pricing.discount !== undefined && !(model.pricing.discount > 0 && model.pricing.discount < 1))) {
      throw new RouterError("invalid_pricing", 400, "Model prices must be finite nonnegative rates");
    }
  }
}

export function validateSelection(model: Omit<SelectedModel, "revision" | "updatedAt">): void {
  validateModel(model);
  if (!validIdentifier(model.id) || !/^[a-z][a-z0-9_-]{0,63}$/.test(model.providerId) || typeof model.enabled !== "boolean" ||
      !Array.isArray(model.operations) || model.operations.length === 0 || new Set(model.operations).size !== model.operations.length ||
      model.operations.some(operation => !OPERATIONS.includes(operation) || !operationTypes[operation].includes(model.type))) {
    throw new RouterError("invalid_selection", 400, "Selected model operations must match its type");
  }
}
