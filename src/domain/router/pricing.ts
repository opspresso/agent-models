import type { Measurement, ModelType, Pricing, Settlement, UsageAmounts } from "./types.ts";

type Cost = Pick<Settlement, "costUsd" | "costSource">;
const unknown: Cost = { costUsd: null, costSource: "unknown" };

/** Missing usage and missing prices stay unknown. Values are provider-normalized, not guessed. */
export function priceUsage(type: ModelType, pricing: Pricing | null, amounts: UsageAmounts, measurement: Measurement): Cost {
  if (measurement === "not_started") return { costUsd: 0, costSource: "not_started" };
  if (measurement !== "reported") return unknown;
  if (Object.values(amounts).some(value => !Number.isFinite(value) || value < 0)) return unknown;
  if (amounts.providerCostUsd !== undefined) return { costUsd: amounts.providerCostUsd, costSource: "provider" };
  if (!pricing) return unknown;
  if (type === "text" && (amounts.inputTokens === undefined || amounts.outputTokens === undefined)) return unknown;
  if (["embedding", "decision"].includes(type) && amounts.inputTokens === undefined) return unknown;
  if (type === "rerank" && (pricing.perSearch !== undefined ? amounts.searches === undefined : amounts.inputTokens === undefined)) return unknown;
  if (type === "transcription" && (pricing.perAudioMinute !== undefined ? amounts.audioSeconds === undefined : amounts.inputTokens === undefined || amounts.outputTokens === undefined)) return unknown;
  if (type === "image" && (pricing.imageOutputPer1M ? amounts.imageOutputTokens === undefined : amounts.images === undefined)) return unknown;
  if (type === "image" && !pricing.imageOutputPer1M && pricing.perImage !== undefined) {
    if (amounts.images === undefined || (pricing.perInputImage !== undefined && amounts.inputImages === undefined)) return unknown;
    const cost = amounts.images * pricing.perImage + (amounts.inputImages ?? 0) * (pricing.perInputImage ?? 0);
    return Number.isFinite(cost) ? { costUsd: Number(cost.toFixed(12)), costSource: "calculated" } : unknown;
  }
  let cost = 0;
  let observed = false;
  const add = (quantity: number | undefined, rate: number | undefined, unit = 1): boolean => {
    if (quantity === undefined) return true;
    observed = true;
    if (quantity === 0) return true;
    if (rate === undefined) return false;
    cost += quantity * rate / unit;
    return true;
  };
  const cached = amounts.cachedInputTokens ?? 0;
  const written = amounts.cacheWriteInputTokens ?? 0;
  const imageInput = amounts.imageInputTokens ?? 0;
  if ((cached || written || imageInput) && amounts.inputTokens === undefined) return unknown;
  const ordinaryInput = amounts.inputTokens === undefined ? undefined : amounts.inputTokens - cached - written - imageInput;
  if (ordinaryInput !== undefined && ordinaryInput < 0) return unknown;
  const imageOutput = amounts.imageOutputTokens ?? 0;
  if (imageOutput && amounts.outputTokens === undefined) return unknown;
  const ordinaryOutput = amounts.outputTokens === undefined ? undefined : amounts.outputTokens - imageOutput;
  if (ordinaryOutput !== undefined && ordinaryOutput < 0) return unknown;
  if (!add(ordinaryInput, pricing.inputPer1M, 1e6) || !add(ordinaryOutput, pricing.outputPer1M, 1e6) ||
      !add(amounts.cachedInputTokens, pricing.cachedInputPer1M, 1e6) || !add(amounts.cacheWriteInputTokens, pricing.cacheWriteInputPer1M, 1e6) ||
      !add(amounts.imageInputTokens, pricing.imageInputPer1M, 1e6) || !add(amounts.imageOutputTokens, pricing.imageOutputPer1M, 1e6) ||
      !add(amounts.audioSeconds, pricing.perAudioMinute, 60) || !add(amounts.searches, pricing.perSearch)) return unknown;
  // Flat image rates and image-token rates describe alternative billing methods.
  if (!(pricing.imageOutputPer1M && pricing.imageOutputPer1M > 0) && !add(amounts.images, pricing.perImage)) return unknown;
  if (pricing.perInputImage !== undefined && (amounts.inputImages === undefined || !add(amounts.inputImages, pricing.perInputImage))) return unknown;
  return observed && Number.isFinite(cost) ? { costUsd: Number(cost.toFixed(12)), costSource: "calculated" } : unknown;
}
