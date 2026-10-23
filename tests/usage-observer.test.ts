import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createUsageObserver } from "../src/infrastructure/providers/usage-observer.ts";
import type { Operation, ProviderKind, ModelType } from "../src/domain/router/types.ts";

async function observe(body: string, operation: Operation = "chat/completions", kind: ProviderKind = "openai", type: ModelType = "text", sse = false, chunkSize = 13) {
  const observer = createUsageObserver(operation, kind, type, sse);
  const bytes = new TextEncoder().encode(body);
  for (let offset = 0; offset < bytes.length; offset += chunkSize) await observer.write(bytes.subarray(offset, offset + chunkSize));
  await observer.end();
  return observer.result();
}
const event = (body: unknown) => `data: ${JSON.stringify(body)}\n\n`;

describe("streamed usage extraction", () => {
  it("observes JSON across byte boundaries without storing message contents", async () => {
    const result = await observe(JSON.stringify({ choices: [{ message: { content: "한글🙂" } }], usage: { prompt_tokens: 20, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 10 } } }), undefined, undefined, undefined, false, 1);
    assert.equal(result.complete, true);
    assert.deepEqual(result.amounts, { inputTokens: 20, outputTokens: 5, cachedInputTokens: 10 });
    assert.equal(result.measurement, "reported");
  });
  it("merges Anthropic start and delta counters without counting cache reads twice", async () => {
    const result = await observe(event({ type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 5, output_tokens: 0 } } }) +
      event({ type: "message_delta", usage: { output_tokens: 7 } }) + event({ type: "message_stop" }), "messages", "anthropic", "text", true, 1);
    assert.equal(result.complete, true);
    assert.deepEqual(result.amounts, { inputTokens: 35, outputTokens: 7, cachedInputTokens: 20, cacheWriteInputTokens: 5 });
  });
  it("recognizes the final chat usage and DONE marker with CRLF and multiline data", async () => {
    const body = ': heartbeat\r\nevent: chunk\r\ndata: {"usage":\r\ndata: {"prompt_tokens":3,"completion_tokens":4}}\r\n\r\ndata: [DONE]\r\n\r\n';
    for (const size of [1, 2, 7, 64]) {
      const result = await observe(body, "chat/completions", "openai", "text", true, size);
      assert.equal(result.complete, true);
      assert.deepEqual(result.amounts, { inputTokens: 3, outputTokens: 4 });
    }
  });
  it("does not promote a truncated or missing-terminal stream to complete usage", async () => {
    const result = await observe(event({ usage: { prompt_tokens: 3, completion_tokens: 4 } }), "chat/completions", "openai", "text", true);
    assert.equal(result.complete, false);
    assert.equal(result.measurement, "partial");
    const truncated = await observe('data: {"usage":{"prompt_tokens":3}', "chat/completions", "openai", "text", true);
    assert.equal(truncated.complete, false);
    assert.equal(truncated.measurement, "unavailable");
  });
  it("freezes terminal accounting when a consumer would stop at DONE", async () => {
    const result = await observe(event({ usage: { prompt_tokens: 3, completion_tokens: 4 } }) + 'data: [DONE]\n\n' +
      event({ usage: { prompt_tokens: 999, completion_tokens: 999 } }), "chat/completions", "openai", "text", true, 10000);
    assert.equal(result.complete, true);
    assert.deepEqual(result.amounts, { inputTokens: 3, outputTokens: 4 });
  });
  it("reads Responses final usage and keeps upstream error messages out of accounting", async () => {
    const result = await observe(event({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 10, output_tokens: 8, output_tokens_details: { reasoning_tokens: 5 } } } }), "responses", "openai", "text", true);
    assert.equal(result.complete, true);
    assert.deepEqual(result.amounts, { inputTokens: 10, outputTokens: 8, reasoningTokens: 5 });
    const failed = await observe(event({ type: "response.failed", response: { status: "failed", error: { message: "secret-input-and-credential" } } }), "responses", "openai", "text", true);
    assert.equal(failed.errorCode, "provider_error");
    assert.ok(!JSON.stringify(failed).includes("secret-input"));
  });
  it("ignores prompt-shaped usage fields and rejects invalid counters", async () => {
    const result = await observe(JSON.stringify({ choices: [{ message: { usage: { prompt_tokens: 999 } } }], "usage.prompt_tokens": 999, usage: { prompt_tokens: -5, completion_tokens: 1 } }));
    assert.deepEqual(result.amounts, { outputTokens: 1 });
    assert.equal(result.measurement, "partial");
  });
  it("counts large image payloads without keeping the base64 string", async () => {
    const observer = createUsageObserver("images/generations", "xai", "image", false);
    await observer.write(new TextEncoder().encode('{"data":[{"b64_json":"'));
    const chunk = new TextEncoder().encode("a".repeat(64 * 1024));
    for (let count = 0; count < 128; count++) await observer.write(chunk);
    await observer.write(new TextEncoder().encode('"}],"usage":{"cost_in_usd_ticks":400000000}}'));
    await observer.end();
    assert.deepEqual(observer.result().amounts, { images: 1, providerCostUsd: 0.04 });
    assert.equal(observer.result().measurement, "reported");
  });
  it("extracts metadata after a large image inside a single SSE event", async () => {
    const observer = createUsageObserver("chat/completions", "openrouter", "image", true);
    await observer.write(new TextEncoder().encode('data: {"choices":[{"message":{"images":[{"image_url":{"url":"data:image/png;base64,'));
    const chunk = new TextEncoder().encode("a".repeat(65536));
    for (let count = 0; count < 16; count++) await observer.write(chunk);
    await observer.write(new TextEncoder().encode('"}}]}}],"usage":{"prompt_tokens":5,"completion_tokens":100,"completion_tokens_details":{"image_tokens":90}}}\n\ndata: [DONE]\n\n'));
    await observer.end();
    assert.equal(observer.result().complete, true);
    assert.deepEqual(observer.result().amounts, { inputTokens: 5, outputTokens: 100, imageOutputTokens: 90, images: 1 });
  });
  it("normalizes Google reasoning and image token modalities", async () => {
    const result = await observe(event({ candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 100, thoughtsTokenCount: 5,
      promptTokensDetails: [{ modality: "IMAGE", tokenCount: 10 }], candidatesTokensDetails: [{ modality: "IMAGE", tokenCount: 80 }] } }), "streamGenerateContent", "google", "image", true);
    assert.deepEqual(result.amounts, { inputTokens: 20, outputTokens: 105, reasoningTokens: 5, imageInputTokens: 10, imageOutputTokens: 80 });
  });
  it("observes specialized billing units and never treats counted tokens as consumed tokens", async () => {
    assert.deepEqual((await observe('{"usage":{"seconds":12.5}}', "audio/transcriptions", "openai", "transcription")).amounts, { audioSeconds: 12.5 });
    assert.deepEqual((await observe('{"meta":{"billed_units":{"search_units":2}}}', "rerank", "selfhosted", "rerank")).amounts, { searches: 2 });
    assert.deepEqual((await observe('{"input_tokens":500}', "messages/count_tokens", "anthropic")).amounts, { providerCostUsd: 0 });
  });
});
