import { z } from "zod";
import { MODEL_TYPES, OPERATIONS, PROVIDER_KINDS } from "../domain/router/types.ts";

const identifier = z.string().trim().min(1).max(200);
const rate = z.number().finite().nonnegative();
export const providerInput = z.object({
  revision: z.number().int().positive().nullable(),
  provider: z.object({ id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), name: z.string().min(1).max(200), kind: z.enum(PROVIDER_KINDS),
    baseUrl: z.url().max(2000), auth: z.enum(["secret", "none", "sigv4"]), enabled: z.boolean(), secret: z.string().max(8192).optional() }).strict(),
}).strict();
export const modelInput = z.object({
  revision: z.number().int().positive().nullable(),
  model: z.object({ id: identifier, providerId: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), wireId: identifier, displayName: z.string().min(1).max(200),
    type: z.enum(MODEL_TYPES), contextWindow: z.number().int().nonnegative(), maxTokens: z.number().int().nonnegative(), enabled: z.boolean(),
    operations: z.array(z.enum(OPERATIONS)).min(1).max(OPERATIONS.length),
    capabilities: z.object({ tools: z.boolean(), structuredOutput: z.boolean(), imageInput: z.boolean(), reasoning: z.boolean(),
      imageGeneration: z.boolean().optional(), embedding: z.boolean().optional(), rerank: z.boolean().optional(), transcription: z.boolean().optional(),
      decision: z.boolean().optional(), reasoningWithTools: z.boolean().optional() }).strict(),
    pricing: z.object({ inputPer1M: rate, outputPer1M: rate, cachedInputPer1M: rate.optional(), cacheWriteInputPer1M: rate.optional(),
      imageInputPer1M: rate.optional(), imageOutputPer1M: rate.optional(), perImage: rate.optional(), perInputImage: rate.optional(),
      perSearch: rate.optional(), perAudioMinute: rate.optional(), discount: rate.optional() }).strict().nullable(),
    catalogId: identifier.optional(), maker: identifier.optional(), family: identifier.optional(),
  }).strict(),
}).strict();
export const usageQuery = z.object({
  from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }),
  groupBy: z.enum(["model", "user", "agent", "service", "day"]).default("model"),
  subject: identifier.optional(), agentId: identifier.optional(), modelId: identifier.optional(), service: identifier.optional(),
  after: identifier.optional(), limit: z.coerce.number().int().min(1).max(500).default(100),
}).strict();
