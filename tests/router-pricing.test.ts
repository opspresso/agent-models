import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { priceUsage } from "../src/domain/router/pricing.ts";
import { providerUrl, validateSelection } from "../src/domain/router/validation.ts";

describe("model usage valuation", () => {
  it("keeps unknown prices, incomplete usage and unobserved token axes unpriced", () => {
    const prices = { inputPer1M: 2, outputPer1M: 6 };
    for (const result of [priceUsage("text", null, { inputTokens: 10, outputTokens: 20 }, "reported"),
      priceUsage("text", prices, { inputTokens: 10 }, "reported"), priceUsage("text", prices, { inputTokens: 10, outputTokens: 20 }, "partial"),
      priceUsage("text", prices, {}, "unavailable")]) assert.equal(result.costUsd, null);
  });
  it("distinguishes confirmed no-dispatch and explicit free rates", () => {
    assert.deepEqual(priceUsage("text", null, {}, "not_started"), { costUsd: 0, costSource: "not_started" });
    assert.deepEqual(priceUsage("text", { inputPer1M: 0, outputPer1M: 0 }, { inputTokens: 100, outputTokens: 20 }, "reported"), { costUsd: 0, costSource: "calculated" });
  });
  it("prices disjoint normal, cached and cache-write input without counting reasoning twice", () => {
    assert.equal(priceUsage("text", { inputPer1M: 2, outputPer1M: 6, cachedInputPer1M: 0.2, cacheWriteInputPer1M: 2.5 },
      { inputTokens: 1000, cachedInputTokens: 400, cacheWriteInputTokens: 200, outputTokens: 100, reasoningTokens: 50 }, "reported").costUsd, 0.00198);
    assert.equal(priceUsage("text", { inputPer1M: 2, outputPer1M: 6 },
      { inputTokens: 10, cachedInputTokens: 11, outputTokens: 0 }, "reported").costUsd, null);
  });
  it("prefers a reported provider charge, including an explicit zero", () => {
    assert.deepEqual(priceUsage("text", null, { providerCostUsd: 0 }, "reported"), { costUsd: 0, costSource: "provider" });
    assert.equal(priceUsage("image", null, { providerCostUsd: 0.127 }, "reported").costUsd, 0.127);
    assert.equal(priceUsage("text", null, { providerCostUsd: Infinity }, "reported").costUsd, null);
  });
  it("prices token images without adding an alternative flat price", () => {
    assert.equal(priceUsage("image", { inputPer1M: 2, outputPer1M: 0, imageInputPer1M: 8, imageOutputPer1M: 30, perImage: 0.04 },
      { inputTokens: 200, imageInputTokens: 100, outputTokens: 1000, imageOutputTokens: 1000, images: 1, inputImages: 1 }, "reported").costUsd, 0.031);
    assert.equal(priceUsage("image", { inputPer1M: 0, outputPer1M: 0, perImage: 0.04 }, { images: 2 }, "reported").costUsd, 0.08);
    assert.equal(priceUsage("image", { inputPer1M: 0, outputPer1M: 0, perImage: 0.04, perInputImage: 0.01 },
      { images: 2, inputImages: 3, outputTokens: 1000, imageOutputTokens: 1000 }, "reported").costUsd, 0.11);
  });
  it("preserves embedding, rerank search and transcription duration billing units", () => {
    assert.equal(priceUsage("embedding", { inputPer1M: 0.1, outputPer1M: 0 }, { inputTokens: 1000 }, "reported").costUsd, 0.0001);
    assert.equal(priceUsage("rerank", { inputPer1M: 0, outputPer1M: 0, perSearch: 0.001 }, { searches: 2 }, "reported").costUsd, 0.002);
    assert.equal(priceUsage("transcription", { inputPer1M: 0, outputPer1M: 0, perAudioMinute: 0.006 }, { audioSeconds: 90 }, "reported").costUsd, 0.009);
  });
});

it("accepts internal configured endpoints but never embedded credentials or redirect parameters", () => {
  assert.equal(providerUrl("http://model.internal:8000/v1/"), "http://model.internal:8000/v1");
  for (const url of ["file:///etc/passwd", "https://key:secret@example.test", "https://example.test?key=secret", "https://example.test/#fragment"]) assert.throws(() => providerUrl(url));
});

it("rejects a model type or execution operation that contradicts its declared capabilities", () => {
  const model = { id: "local/embed", providerId: "local", wireId: "embed", displayName: "Embedding", type: "embedding" as const,
    contextWindow: 8192, maxTokens: 0, pricing: null, enabled: true, operations: ["embeddings" as const],
    capabilities: { tools: false, structuredOutput: false, imageInput: false, reasoning: false } };
  validateSelection(model);
  assert.throws(() => validateSelection({ ...model, operations: ["chat/completions"] }));
  assert.throws(() => validateSelection({ ...model, capabilities: { ...model.capabilities, imageGeneration: true } }));
});
