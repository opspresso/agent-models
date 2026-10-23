import type { ModelCapabilities, ModelPricing } from "../catalog/registry.ts";

export const MODEL_TYPES = ["text", "image", "embedding", "rerank", "transcription", "decision"] as const;
export type ModelType = typeof MODEL_TYPES[number];
export const PROVIDER_KINDS = ["openai", "anthropic", "google", "xai", "openrouter", "bedrock", "selfhosted"] as const;
export type ProviderKind = typeof PROVIDER_KINDS[number];
export const OPERATIONS = ["chat/completions", "responses", "messages", "messages/count_tokens", "embeddings",
  "images", "images/generations", "images/edits", "audio/transcriptions", "rerank", "decisions", "generateContent", "streamGenerateContent"] as const;
export type Operation = typeof OPERATIONS[number];

export interface Principal {
  /** Studio's stable subject, or an explicitly authorized service subject for system jobs. */
  subject: string;
  kind: "user" | "service";
  service: string;
  admin: boolean;
  canInvoke: boolean;
  /** Set only by the authenticated delegation boundary. */
  agentId?: string;
}

export interface Provider {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  auth: "secret" | "none" | "sigv4";
  enabled: boolean;
  revision: number;
  updatedAt: string;
}

export interface StoredProvider extends Provider {
  encryptedSecret: string | null;
}

export interface Pricing extends ModelPricing {
  cacheWriteInputPer1M?: number;
}

export interface ModelFacts {
  wireId: string;
  displayName: string;
  type: ModelType;
  contextWindow: number;
  maxTokens: number;
  capabilities: ModelCapabilities;
  /** null is unknown; an explicit zero rate is free. */
  pricing: Pricing | null;
  catalogId?: string;
  maker?: string;
  family?: string;
}

/** A provider listing may establish availability without establishing limits, type or prices. */
export interface DiscoveredModel extends Partial<ModelFacts> {
  wireId: string;
  displayName: string;
  providerId: string;
  available: boolean;
  observedAt: string;
}

export interface SelectedModel extends ModelFacts {
  id: string;
  providerId: string;
  enabled: boolean;
  operations: Operation[];
  revision: number;
  updatedAt: string;
}

/** Untrusted input and model output are never part of this record. */
export interface UsageAmounts {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  reasoningTokens?: number;
  imageInputTokens?: number;
  imageOutputTokens?: number;
  images?: number;
  inputImages?: number;
  audioSeconds?: number;
  searches?: number;
  providerCostUsd?: number;
}

export const USAGE_UNITS = ["inputTokens", "outputTokens", "cachedInputTokens", "cacheWriteInputTokens", "reasoningTokens",
  "imageInputTokens", "imageOutputTokens", "images", "inputImages", "audioSeconds", "searches"] as const;
export type UsageUnit = typeof USAGE_UNITS[number];

export type Outcome = "succeeded" | "failed" | "cancelled" | "unknown";
export type Measurement = "reported" | "partial" | "unavailable" | "not_started";
export interface Settlement {
  outcome: Outcome;
  measurement: Measurement;
  amounts: UsageAmounts;
  costUsd: number | null;
  costSource: "provider" | "calculated" | "unknown" | "not_started";
  httpStatus: number | null;
  /** Bounded error category, never an upstream message. */
  errorCode: string | null;
  responseBytes: number;
  durationMs: number;
}

export interface Admission {
  requestId: string;
  principal: Principal;
  modelId: string;
  operation: Operation;
  /** Globally unique owner for this execution; never supplied by a caller. */
  executionId: string;
  deadlineAt: string;
}

export interface RoutedRequest extends Admission {
  model: SelectedModel;
  provider: StoredProvider;
  startedAt: string;
}

export interface UsageRecord {
  requestId: string;
  service: string;
  subject: string;
  principalKind: Principal["kind"];
  agentId: string | null;
  modelId: string;
  providerId: string;
  operation: Operation;
  state: "running" | Outcome;
  pricing: Pricing | null;
  startedAt: string;
  finishedAt: string | null;
  settlement: Settlement | null;
}

export interface UsageQuery {
  from: string;
  to: string;
  subject?: string;
  agentId?: string;
  modelId?: string;
  service?: string;
  groupBy: "model" | "user" | "agent" | "service" | "day";
  limit: number;
  after?: string;
}

export interface UsageSummary {
  key: string | null;
  requests: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  unknown: number;
  running: number;
  unpriced: number;
  measuredRequests: number;
  usage: Partial<Record<UsageUnit, { total: number; observedRequests: number }>>;
  costUsd: number;
}
