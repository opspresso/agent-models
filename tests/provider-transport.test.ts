import assert from "node:assert/strict";
import { it } from "node:test";
import { createProviderTransport, providerEndpoint } from "../src/infrastructure/providers/transport.ts";
import { createModelDiscovery } from "../src/infrastructure/providers/discovery.ts";
import { priceUsage } from "../src/domain/router/pricing.ts";
import type { Catalog } from "../src/domain/catalog/registry.ts";
import type { InferenceBody, InferenceTransport } from "../src/domain/router/transport.ts";
import type { SelectedModel, StoredProvider } from "../src/domain/router/types.ts";

const provider: StoredProvider = { id: "local", name: "Local", kind: "selfhosted", baseUrl: "http://model.internal/v1", auth: "secret", enabled: true, encryptedSecret: null, revision: 1, updatedAt: "2026-10-24T00:00:00Z" };
const model: SelectedModel = { id: "selected-model", providerId: provider.id, wireId: "wire-model", displayName: "Model", type: "text", contextWindow: 8192, maxTokens: 1024,
  capabilities: { tools: true, structuredOutput: true, imageInput: false, reasoning: false }, pricing: null, operations: ["chat/completions"], enabled: true, revision: 1, updatedAt: provider.updatedAt };
const invoke = (transport: InferenceTransport, body: InferenceBody, changes: Partial<Parameters<InferenceTransport["execute"]>[0]> = {}) => transport.execute({
  provider, model, body, operation: "chat/completions", secret: "fixture-key", headers: {}, signal: new AbortController().signal, onDispatch() {}, ...changes,
});
async function collect(value: AsyncIterable<Uint8Array>) { const chunks = []; for await (const chunk of value) chunks.push(chunk); return Buffer.concat(chunks).toString("utf8"); }

it("forwards bytes unchanged while replacing the model and retaining server credential ownership", async () => {
  const raw = 'data: {"choices":[{"delta":{"content":"한글"}}]}\n\ndata: {"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\ndata: [DONE]\n\n';
  let called = 0;
  const transport = createProviderTransport({ request: async (url, init) => {
    called++;
    assert.equal(String(url), "http://model.internal/v1/chat/completions");
    assert.equal(init?.redirect, "error");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), "Bearer fixture-key");
    assert.equal(headers.get("cookie"), null);
    assert.equal(headers.get("x-secret"), null);
    assert.deepEqual(JSON.parse(String(init?.body)), { messages: [], stream: true, stream_options: { include_usage: true }, model: "wire-model" });
    return new Response(raw, { headers: { "content-type": "text/event-stream", "set-cookie": "private=value", "content-length": "9000", "x-request-id": "upstream-id" } });
  } });
  const input = { model: "unselected-model", messages: [], stream: true };
  const response = await invoke(transport, { kind: "json", value: input }, { headers: { authorization: "Bearer attacker", cookie: "private", "x-secret": "discard" } });
  assert.equal(await collect(response.body), raw);
  assert.equal(input.model, "unselected-model", "caller input is not mutated");
  assert.equal(called, 1);
  assert.equal(response.headers["set-cookie"], undefined);
  assert.equal(response.headers["content-length"], undefined);
  assert.deepEqual(response.observation().amounts, { inputTokens: 5, outputTokens: 2 });
});

it("refuses hosted provider resources before dispatch while preserving tool argument data", async () => {
  let calls = 0;
  const transport = createProviderTransport({ request: async () => { calls++; return Response.json({}); } });
  for (const value of [{ previous_response_id: "another-user" }, { background: true }, { store: true }, { conversation: "foreign" },
    { tools: [{ type: "file_search", vector_store_ids: ["foreign"] }] },
    { input: [{ role: "user", content: [{ type: "input_file", file_id: "foreign" }] }] }]) {
    await assert.rejects(invoke(transport, { kind: "json", value }, { operation: "responses" }), { code: "provider_state_forbidden" });
  }
  assert.equal(calls, 0);
  const response = await invoke(transport, { kind: "json", value: { tools: [{ type: "function", name: "read_file" }], input: [{ type: "function_call", arguments: '{"file_id":"caller-data"}' }] } }, { operation: "responses" });
  await collect(response.body);
  assert.equal(calls, 1);
});

it("does not relay provider error bodies, cookies or redirects and never retries", async () => {
  let calls = 0;
  const transport = createProviderTransport({ request: async () => { calls++; return Response.json({ error: "fixture-secret-and-prompt" }, { status: 429, headers: { "retry-after": "3", location: "https://foreign.example" } }); } });
  const response = await invoke(transport, { kind: "json", value: {} });
  assert.equal(response.status, 429);
  assert.equal(response.headers["retry-after"], "3");
  assert.equal(response.headers.location, undefined);
  assert.ok(!(await collect(response.body)).includes("fixture-secret"));
  assert.equal(calls, 1);
  assert.equal(response.observation().errorCode, "provider_http_error");
});

it("cancels the upstream reader when the downstream stops", async () => {
  let cancelled = false;
  const transport = createProviderTransport({ request: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('data: {"usage":{"prompt_tokens":3}}\n\n')); },
    cancel() { cancelled = true; },
  }), { headers: { "content-type": "text/event-stream" } }) });
  const response = await invoke(transport, { kind: "json", value: {} });
  const iterator = response.body[Symbol.asyncIterator]();
  await iterator.next();
  await iterator.return?.();
  assert.equal(cancelled, true);
  assert.equal(response.observation().complete, false);
});

it("uses the selected multipart model and native authentication headers", async () => {
  const transport = createProviderTransport({ request: async (_url, init) => {
    assert.ok(init?.body instanceof FormData);
    assert.equal(init.body.get("model"), "wire-model");
    assert.equal(await (init.body.get("file") as Blob).text(), "fixture audio");
    return Response.json({ text: "transcript", usage: { seconds: 1.5 } });
  } });
  const response = await invoke(transport, { kind: "multipart", parts: [{ name: "model", value: "wrong" }, { name: "file", value: new TextEncoder().encode("fixture audio"), filename: "audio.wav", contentType: "audio/wav" }] },
    { operation: "audio/transcriptions", model: { ...model, type: "transcription" } });
  await collect(response.body);
  assert.equal(response.observation().amounts.audioSeconds, 1.5);
});

it("pins operation paths and encodes Google wire IDs without accepting caller paths", () => {
  assert.equal(providerEndpoint({ ...provider, kind: "google", baseUrl: "https://model.internal/v1beta/openai" }, "generateContent", "models/test/model"), "https://model.internal/v1beta/models/test%2Fmodel:generateContent");
  assert.equal(providerEndpoint({ ...provider, kind: "google", baseUrl: "https://model.internal/v1beta" }, "images/generations", "image-model"), "https://model.internal/v1beta/openai/images/generations");
  assert.equal(providerEndpoint({ ...provider, kind: "openrouter", baseUrl: "https://model.internal/api/v1" }, "decisions", "model"), "https://model.internal/api/alpha/decisions");
  assert.equal(providerEndpoint(provider, "decisions", "model"), "http://model.internal/v1/systemone");
});

it("preserves OpenRouter's Images endpoint and flat edit billing despite synthetic token counts", async () => {
  const transport = createProviderTransport({ request: async (url) => {
    assert.equal(String(url), "http://model.internal/v1/images");
    return Response.json({ data: [{ b64_json: "fixture", media_type: "image/png" }], usage: { prompt_tokens: 3, completion_tokens: 1000, completion_tokens_details: { image_tokens: 1000 } } });
  } });
  const response = await invoke(transport, { kind: "json", value: { input_references: [{ type: "image_url" }, { type: "image_url" }] } }, {
    operation: "images", provider: { ...provider, kind: "openrouter" }, model: { ...model, type: "image" },
  });
  await collect(response.body);
  const observed = response.observation();
  assert.equal(observed.amounts.inputImages, 2);
  assert.equal(observed.amounts.images, 1);
  assert.equal(priceUsage("image", { inputPer1M: 0, outputPer1M: 0, perImage: 0.04, perInputImage: 0.01 }, observed.amounts, observed.measurement).costUsd, 0.06);
});

const catalog: Catalog = { version: 1, updatedAt: "2026-10-24T00:00:00Z", source: "https://example.test", providers: [], makers: {}, models: [] };
it("collects all OpenRouter modalities and retains unknown facts as unknown", async () => {
  const paths: string[] = [];
  const discovery = createModelDiscovery({ catalog: () => catalog, request: async url => {
    const target = new URL(String(url)); paths.push(target.pathname + target.search);
    const id = target.searchParams.get("output_modalities") ?? (target.pathname.includes("embeddings") ? "embedding" : target.pathname.includes("images") ? "image" : "text");
    return Response.json({ data: [{ id, name: id }] });
  } });
  const models = await discovery.discover({ ...provider, kind: "openrouter" }, "fixture");
  assert.equal(paths.length, 6);
  assert.equal(models.length, 6);
  assert.equal(models.find(model => model.wireId === "transcription")?.type, "transcription");
  assert.equal(models.find(model => model.wireId === "embedding")?.maxTokens, 0);
  assert.equal(models.find(model => model.wireId === "text")?.pricing, undefined);
  assert.equal(models.find(model => model.wireId === "text")?.contextWindow, undefined);
});

it("follows Google pagination with credentials in headers and no query-key exposure", async () => {
  let calls = 0;
  const discovery = createModelDiscovery({ catalog: () => catalog, request: async (url, init) => {
    calls++;
    const target = new URL(String(url));
    assert.equal(target.searchParams.has("key"), false);
    assert.equal(new Headers(init?.headers).get("x-goog-api-key"), "fixture");
    return Response.json(calls === 1 ? { models: [{ name: "models/first" }], nextPageToken: "next-page" } : { models: [{ name: "models/embed", supportedGenerationMethods: ["embedContent"], inputTokenLimit: 1000 }] });
  } });
  const models = await discovery.discover({ ...provider, kind: "google" }, "fixture");
  assert.equal(calls, 2);
  assert.equal(models[1]?.type, "embedding");
  assert.equal(models[1]?.contextWindow, 1000);
});

it("rejects malformed listings and repeated pagination instead of replacing a catalog with partial data", async () => {
  const bad = createModelDiscovery({ catalog: () => catalog, request: async () => Response.json({ data: [{ noId: true }] }) });
  await assert.rejects(bad.discover(provider, "fixture"), { code: "invalid_catalog" });
  const repeated = createModelDiscovery({ catalog: () => catalog, request: async () => Response.json({ data: [], has_more: true, last_id: "same" }) });
  await assert.rejects(repeated.discover(provider, "fixture"), { code: "invalid_catalog" });
});

it("rejects both ProtoJSON spellings of Google hosted context before provider dispatch", async () => {
  let dispatched=0,requests=0;
  const transport=createProviderTransport({request:async()=>{requests++;return Response.json({});}});
  const foreign={mime_type:"text/plain",file_uri:"https://generativelanguage.googleapis.com/v1beta/files/other-user"};
  const cases=[
    {cached_content:"cachedContents/other-user"},
    {cachedContent:null,cached_content:"cachedContents/other-user"},
    {contents:[{role:"user",parts:[{file_data:foreign}]}]},
    {contents:[{role:"user",parts:[{fileData:null,file_data:foreign}]}]},
    {system_instruction:{parts:[{file_data:foreign}]}},
    {systemInstruction:{parts:[{fileData:{mimeType:"text/plain",fileUri:foreign.file_uri}}]}},
  ];
  for(const operation of ["generateContent","streamGenerateContent"] as const)for(const value of cases)
    await assert.rejects(invoke(transport,{kind:"json",value},{operation,provider:{...provider,kind:"google",baseUrl:"https://generativelanguage.googleapis.com/v1beta"},onDispatch(){dispatched++;}}),{code:"provider_state_forbidden"});
  assert.equal(requests,0);assert.equal(dispatched,0);
});
