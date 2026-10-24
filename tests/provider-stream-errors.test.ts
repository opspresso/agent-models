import assert from "node:assert/strict";
import { it } from "node:test";
import { createProviderTransport } from "../src/infrastructure/providers/transport.ts";
import { createInference } from "../src/application/inference.ts";
import { priceUsage } from "../src/domain/router/pricing.ts";
import { MAX_SSE_EVENT_BYTES } from "../src/infrastructure/providers/sse-guard.ts";
import type { RouterRepository } from "../src/domain/router/repository.ts";
import type { Operation, Principal, SelectedModel, Settlement, StoredProvider } from "../src/domain/router/types.ts";

const provider: StoredProvider = { id: "fixture", name: "Fixture", kind: "openai", baseUrl: "https://provider.fixture.test/v1", auth: "none", enabled: true, encryptedSecret: null, revision: 1, updatedAt: "2026-10-24T00:00:00Z" };
const model: SelectedModel = { id: "fixture/model", providerId: "fixture", wireId: "wire-model", displayName: "Fixture", type: "text", contextWindow: 8192, maxTokens: 1024,
  capabilities: { tools: true, structuredOutput: true, imageInput: false, reasoning: false }, pricing: { inputPer1M: 1, outputPer1M: 2 }, operations: ["chat/completions"], enabled: true, revision: 1, updatedAt: provider.updatedAt };
const principal: Principal = { subject: "fixture-user", kind: "user", service: "agent-studio", admin: false, canInvoke: true };
const encode = (text: string) => new TextEncoder().encode(text);
const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const secret = "PRIVATE_UPSTREAM_DIAGNOSTIC_SENTINEL";
const prefix = event({ choices: [{ delta: { content: "한글🙂" } }], usage: { prompt_tokens: 7, completion_tokens: 2 } });

function fixture(chunks: Iterable<Uint8Array>, operation: Operation = "chat/completions", contentType = "text/event-stream") {
  let calls = 0, cancelled = false;
  const iterator = chunks[Symbol.iterator]();
  const transport = createProviderTransport({ request: async () => {
    calls++;
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) { const next = iterator.next(); if (next.done) controller.close(); else controller.enqueue(next.value); },
      cancel() { cancelled = true; iterator.return?.(); },
    }), { headers: { "content-type": contentType } });
  } });
  return { transport, calls: () => calls, cancelled: () => cancelled,
    execute: () => transport.execute({ provider, model, secret: null, operation, body: { kind: "json", value: {} }, headers: {}, signal: new AbortController().signal, onDispatch() {} }) };
}
async function collect(body: AsyncIterable<Uint8Array>) { const chunks: Uint8Array[] = []; for await (const chunk of body) chunks.push(chunk); return Buffer.concat(chunks).toString("utf8"); }

it("keeps a normal prefix in a mixed chunk and replaces first/late native errors without reflecting diagnostic fields", async () => {
  const failures: Array<[Operation, string]> = [
    ["messages", `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: secret, message: secret, details: { token: secret } } })}\n\n`],
    ["chat/completions", event({ error: { code: secret, message: secret } })],
    ["responses", event({ type: "error", code: secret, message: secret, param: secret })],
    ["responses", event({ type: "response.failed", response: { status: "failed", error: { message: secret } } })],
    ["streamGenerateContent", event({ error: { code: 500, status: secret, message: secret, details: [secret] } })],
    ["messages", `event: error\ndata: ${JSON.stringify({ diagnostic: secret })}\n\n`],
    ["chat/completions", event({ error: secret })],
  ];
  for (const [operation, failed] of failures) for (const before of ["", prefix]) {
    const f = fixture([encode(before + failed + event({ shouldNotBeRead: secret }))], operation);
    const response = await f.execute(), output = await collect(response.body);
    assert.ok(output.startsWith(before), operation);
    assert.ok(!output.includes(secret), operation);
    assert.match(output, /Provider response was interrupted/);
    assert.equal(response.observation().errorCode, "provider_error");
    assert.equal(f.calls(), 1);
    if (before) assert.deepEqual(response.observation().amounts, { inputTokens: 7, outputTokens: 2 });
  }
});

it("recognizes UTF-8, CRLF, CR, multiline data and every byte boundary while preserving normal event bytes", async () => {
  const normal = ': heartbeat\r\nevent: message\r\ndata: {"choices":[{"delta":{"content":"한글🙂"}}],\r\ndata: "usage":{"prompt_tokens":3,"completion_tokens":4}}\r\n\r\n';
  const failure = `event: error\rdata: {"type":"error",\rdata: "error":{"message":"${secret}"}}\r\r`;
  for (const size of [1, 2, 7, 4096]) {
    const bytes = encode(normal + failure), chunks = function* () { for (let offset = 0; offset < bytes.length; offset += size) yield bytes.subarray(offset, offset + size); };
    const f = fixture(chunks(), "messages"), response = await f.execute(), output = await collect(response.body);
    assert.ok(output.startsWith(normal)); assert.ok(!output.includes(secret));
    assert.deepEqual(response.observation().amounts, { inputTokens: 3, outputTokens: 4 });
    assert.equal(response.observation().measurement, "partial");
    assert.equal(f.calls(), 1);
  }
});

it("does not expose malformed or invalid UTF-8 error frames", async () => {
  const cases = [encode(`event: error\ndata: {"message":"${secret}"\n\n`), encode(`data: {"message":"${secret}"`), encode(event(secret)),
    Buffer.concat([encode('data: {"error":"'), new Uint8Array([0xff]), encode(secret + '"}\n\n')]),
    encode(`event: ${secret.repeat(20)}\ndata: {}\n\n`)];
  for (const failed of cases) {
    const response = await fixture([encode(prefix), failed]).execute(), output = await collect(response.body);
    assert.ok(output.startsWith(prefix)); assert.ok(!output.includes(secret));
    assert.match(output, /Provider response was interrupted/);
    assert.equal(response.observation().measurement, "partial");
    assert.ok(response.observation().errorCode);
  }
});

it("applies the SSE boundary to case-insensitive media types with parameters", async () => {
  const response = await fixture([encode(event({ error: { message: secret } }))], "chat/completions", "Text/Event-Stream; charset=utf-8").execute();
  const output = await collect(response.body);
  assert.ok(!output.includes(secret)); assert.match(output, /Provider response was interrupted/);
  assert.equal(response.observation().errorCode, "provider_error");
});

it("passes large media/tool events unchanged without a response-wide buffer", async () => {
  const media = "a".repeat(8 * 1024 * 1024);
  const raw = event({ choices: [{ delta: { content: media, tool_calls: [{ function: { arguments: media } }] } }], usage: { prompt_tokens: 7, completion_tokens: 2 } }) + "data: [DONE]\n\n";
  const bytes = encode(raw);
  const chunks = function* () { for (let offset = 0; offset < bytes.length; offset += 65536) yield bytes.subarray(offset, offset + 65536); };
  const response = await fixture(chunks()).execute();
  assert.equal(await collect(response.body), raw);
  assert.deepEqual(response.observation().amounts, { inputTokens: 7, outputTokens: 2 });
  assert.equal(response.observation().measurement, "reported");
});

it("applies the byte limit per event and batches adjacent small verified events", async () => {
  const frame = encode(event({ choices: [{ delta: { content: "a".repeat(1024 * 1024) } }] }));
  const count = Math.ceil(MAX_SSE_EVENT_BYTES / frame.length) + 2;
  const chunks = function* () { for (let index = 0; index < count; index++) yield frame; yield encode("data: [DONE]\n\n"); };
  const response = await fixture(chunks()).execute();
  let bytes = 0;
  for await (const chunk of response.body) bytes += chunk.byteLength;
  assert.equal(bytes, frame.length * count + 14);
  assert.ok(bytes > MAX_SSE_EVENT_BYTES); assert.equal(response.observation().errorCode, null);
  const small = encode(prefix.repeat(100) + "data: [DONE]\n\n");
  const batched = await fixture([small]).execute(), output: Uint8Array[] = [];
  for await (const chunk of batched.body) output.push(chunk);
  assert.deepEqual(Buffer.concat(output), Buffer.from(small));
  assert.equal(output.length, 1, "one network chunk of small events needs one output chunk");
});

it("bounds an unfinished oversized event and cancels upstream without exposing or replaying it", async () => {
  const unit = encode(secret.repeat(Math.ceil(65536 / secret.length)).slice(0, 65536));
  const chunks = function* () { yield encode(prefix); yield encode('data: {"error":{"message":"'); for (let bytes = 0; bytes <= MAX_SSE_EVENT_BYTES; bytes += unit.length) yield unit; yield encode('"}}\n\n'); };
  const f = fixture(chunks()), response = await f.execute(), output = await collect(response.body);
  assert.ok(output.startsWith(prefix)); assert.ok(!output.includes(secret));
  assert.equal(response.observation().errorCode, "provider_event_too_large");
  assert.equal(response.observation().measurement, "partial");
  assert.equal(f.cancelled(), true); assert.equal(f.calls(), 1);
});

it("settles a rejected provider event as failed with partial usage even when the consumer stops on the safe error", async () => {
  const f = fixture([encode(prefix + event({ error: { message: secret }, usage: { prompt_tokens: 7, completion_tokens: 3 } }))]);
  const settlements: Settlement[] = [];
  const repository = { admit: async (input: object) => ({ ...input, model, provider, binding: "fixture" }), settle: async (_service: string, _id: string, _execution: string, value: Settlement) => { settlements.push(value); } } as unknown as RouterRepository;
  const inference = createInference({ repository, transport: f.transport, cipher: { decrypt: () => "", encrypt: () => "" }, executionId: () => "execution", now: Date.now, monotonic: () => performance.now(), timeoutMs: 10000, concurrencyLimit: 1 });
  const response = await inference(principal, { requestId: "request", modelId: model.id, operation: "chat/completions", body: { kind: "json", value: {} }, signal: new AbortController().signal });
  const iterator = response.body[Symbol.asyncIterator]();
  let output = "";
  while (!output.includes("Provider response was interrupted")) { const chunk = await iterator.next(); assert.ok(!chunk.done); output += new TextDecoder().decode(chunk.value); }
  await iterator.return?.(undefined);
  assert.equal(settlements.length, 1); assert.equal(settlements[0]!.outcome, "failed");
  assert.equal(settlements[0]!.measurement, "partial"); assert.equal(settlements[0]!.costUsd, null);
  assert.deepEqual(settlements[0]!.amounts, { inputTokens: 7, outputTokens: 3 }); assert.equal(f.calls(), 1);
  assert.ok(!JSON.stringify(settlements).includes(secret));
});

it("keeps complete failed-response usage authoritative instead of repricing or discarding it", async () => {
  const response = await fixture([encode(event({ type: "response.failed", response: { status: "failed", error: { message: secret },
    usage: { input_tokens: 7, output_tokens: 3, cost: 0.123 } } }))], "responses").execute();
  assert.ok(!(await collect(response.body)).includes(secret));
  const observed = response.observation();
  assert.equal(observed.measurement, "reported"); assert.equal(observed.errorCode, "provider_error");
  assert.deepEqual(priceUsage("text", model.pricing, observed.amounts, observed.measurement), { costUsd: 0.123, costSource: "provider" });
});
