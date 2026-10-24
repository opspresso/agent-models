import assert from "node:assert/strict";
import { it } from "node:test";
import { guardSse, SseBufferBudget, MAX_SSE_EVENT_BYTES, DEFAULT_MAX_STREAM_BUFFER_BYTES, MAX_STREAM_BUFFER_BYTES } from "../src/infrastructure/providers/sse-guard.ts";
import { createUsageObserver } from "../src/infrastructure/providers/usage-observer.ts";
import { createProviderTransport } from "../src/infrastructure/providers/transport.ts";
import { readConfiguration } from "../src/lib/config.ts";
import type { Operation, SelectedModel, StoredProvider } from "../src/domain/router/types.ts";

const encode = (text: string) => new TextEncoder().encode(text);
const observer = () => createUsageObserver("chat/completions", "openai", "text", true);
const complete = encode('data: {"choices":[{"delta":{"content":"valid"}}]}\n\n');
const partial = encode('data: {"choices":[{"delta":{"content":"');
const terminal = encode('"}}]}\n\ndata: [DONE]\n\n');
function gate() { let release!: () => void; return { promise: new Promise<void>(resolve => { release = resolve; }), open: () => release() }; }
async function drain(source: AsyncIterable<Uint8Array>) { const parts: Uint8Array[] = []; for await (const part of source) parts.push(part); return Buffer.concat(parts).toString(); }

it("retains pending and yielded bytes in the shared budget until consumption or cancellation", async () => {
  const budget = new SseBufferBudget(complete.length * 2);
  const first = guardSse((async function* () { yield complete; })(), observer(), "chat/completions", budget);
  assert.equal((await first.next()).done, false);
  assert.equal(budget.retainedBytes, complete.length, "yielded bytes remain owned while the consumer is paused");
  const second = guardSse((async function* () { yield complete; })(), observer(), "chat/completions", budget);
  await second.next(); assert.equal(budget.retainedBytes, complete.length * 2);
  const blocked = observer();
  assert.match(await drain(guardSse((async function* () { yield complete; })(), blocked, "chat/completions", budget)), /Provider response was interrupted/);
  assert.equal(blocked.result().errorCode, "provider_stream_capacity_exceeded");
  assert.equal(budget.retainedBytes, complete.length * 2, "refused stream does not release another stream's reservation");
  await first.return(undefined); assert.equal(budget.retainedBytes, complete.length);
  await second.return(undefined); assert.equal(budget.retainedBytes, 0);
  assert.equal(await drain(guardSse((async function* () { yield complete; })(), observer(), "chat/completions", budget)), new TextDecoder().decode(complete));
  assert.equal(budget.retainedBytes, 0);
});

it("releases unfinished events on upstream failure and all unconsumed parts on downstream cancellation", async () => {
  const budget = new SseBufferBudget(32 * 1024);
  const failed = guardSse((async function* () { yield partial; throw new Error("fixture stream stopped"); })(), observer(), "chat/completions", budget);
  await assert.rejects(drain(failed), /fixture stream stopped/);
  assert.equal(budget.retainedBytes, 0);
  const pieces = [Buffer.concat([partial, encode("a".repeat(4096))]), encode("b".repeat(4096) + '"}}]}\n\n')];
  const held = guardSse((async function* () { yield* pieces; })(), observer(), "chat/completions", budget);
  await held.next(); assert.equal(budget.retainedBytes, pieces.reduce((sum, piece) => sum + piece.length, 0));
  await held.return(undefined); assert.equal(budget.retainedBytes, 0);
});

it("refuses only the capacity-exceeding current event while preserving its verified prefix and observed usage", async () => {
  const usage = encode('data: {"usage":{"prompt_tokens":7}}\n\n');
  const budget = new SseBufferBudget(usage.length + 100), observed = observer();
  const payload = Buffer.concat([usage, encode('data: {"error":{"message":"PRIVATE_SENTINEL' + "a".repeat(200) + '"}}\n\n')]);
  const output = await drain(guardSse((async function* () { yield payload; })(), observed, "chat/completions", budget));
  assert.ok(output.startsWith(new TextDecoder().decode(usage))); assert.ok(!output.includes("PRIVATE_SENTINEL"));
  assert.equal(observed.result().errorCode, "provider_stream_capacity_exceeded");
  assert.equal(observed.result().measurement, "partial"); assert.deepEqual(observed.result().amounts, { inputTokens: 7 });
  assert.equal(budget.retainedBytes, 0);
});

it("allows 64 concurrent small unfinished streams and returns every reservation after completion", async () => {
  const budget = new SseBufferBudget(DEFAULT_MAX_STREAM_BUFFER_BYTES), release = gate(), entered = gate();
  let waiting = 0;
  const pending = Array.from({ length: 64 }, () => {
    const observed = observer();
    const source = (async function* () { yield partial; if (++waiting === 64) entered.open(); await release.promise; yield terminal; })();
    return { observed, output: drain(guardSse(source, observed, "chat/completions", budget)) };
  });
  await entered.promise;
  assert.equal(budget.retainedBytes, partial.length * 64);
  release.open();
  for (const stream of pending) { assert.equal(await stream.output, new TextDecoder().decode(partial) + new TextDecoder().decode(terminal)); assert.equal(stream.observed.result().errorCode, null); }
  assert.equal(budget.retainedBytes, 0);
});

it("shares one capacity owner across calls to the same provider transport", async () => {
  const transport = createProviderTransport({ maxStreamBufferBytes: complete.length, request: async () => new Response(complete, { headers: { "content-type": "text/event-stream" } }) });
  const input = { provider: { id: "fixture", name: "Fixture", kind: "openai", baseUrl: "https://provider.fixture.test/v1", auth: "none", enabled: true, encryptedSecret: null, revision: 1, updatedAt: "2026-10-24" } as StoredProvider,
    model: { wireId: "fixture", type: "text" } as SelectedModel, secret: null, operation: "chat/completions" as Operation, body: { kind: "json" as const, value: {} }, headers: {}, signal: new AbortController().signal, onDispatch() {} };
  const first = await transport.execute(input), iterator = first.body[Symbol.asyncIterator](); await iterator.next();
  const second = await transport.execute(input); assert.match(await drain(second.body), /Provider response was interrupted/);
  assert.equal(second.observation().errorCode, "provider_stream_capacity_exceeded");
  await iterator.return?.();
  const third = await transport.execute(input); assert.equal(await drain(third.body), new TextDecoder().decode(complete));
});

it("configures an explicit 256 MiB default and enforces the 64 MiB to 1 GiB environment range", () => {
  const env = { DATABASE_URL: "postgres://fixture@localhost/models_test", AES_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"), AUTH_BASE_URL: "http://localhost:3400",
    AUTH_SECRET: "fixture-secret".repeat(4), OIDC_ISSUER: "http://localhost:3000/api/auth", OIDC_CLIENT_ID: "fixture", OIDC_CLIENT_SECRET: "fixture" };
  assert.equal(readConfiguration(env).maxStreamBufferBytes, DEFAULT_MAX_STREAM_BUFFER_BYTES);
  for (const value of [MAX_SSE_EVENT_BYTES, MAX_STREAM_BUFFER_BYTES]) assert.equal(readConfiguration({ ...env, MODEL_MAX_STREAM_BUFFER_BYTES: String(value) }).maxStreamBufferBytes, value);
  for (const value of [MAX_SSE_EVENT_BYTES - 1, MAX_STREAM_BUFFER_BYTES + 1, NaN, 1.5]) assert.throws(() => readConfiguration({ ...env, MODEL_MAX_STREAM_BUFFER_BYTES: String(value) }), /MODEL_MAX_STREAM_BUFFER_BYTES/);
});
