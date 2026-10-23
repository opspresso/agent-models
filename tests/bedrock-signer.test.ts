import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { it } from "node:test";
import { createBedrockSigner } from "../src/infrastructure/providers/bedrock-signer.ts";

it("signs the exact buffered payload for the endpoint region with temporary credentials", async () => {
  const sign = createBedrockSigner({ credentials: async () => ({ accessKeyId: "FIXTURE_ACCESS", secretAccessKey: "fixture-secret", sessionToken: "fixture-session" }) });
  const body = '{"model":"fixture","messages":[]}';
  const controller = new AbortController();
  const request = await sign("https://bedrock-mantle.ap-northeast-2.api.aws:8443/v1/chat/completions?a=1&a=2&__proto__=value", {
    method: "POST", headers: { "content-type": "application/json" }, body, signal: controller.signal,
  });
  assert.ok(request.headers.get("authorization")?.includes("/ap-northeast-2/bedrock/aws4_request"));
  assert.equal(request.headers.get("x-amz-security-token"), "fixture-session");
  assert.equal(request.headers.get("x-amz-content-sha256"), createHash("sha256").update(body).digest("hex"));
  assert.equal(await request.text(), body);
  assert.equal(new URL(request.url).searchParams.getAll("a").length, 2);
  controller.abort(); assert.equal(request.signal.aborted, true);
  await assert.rejects(sign("https://model.internal/v1/models"), { code: "invalid_provider" });
});

it("signs the transmitted snapshot when the caller mutates bytes while credentials resolve", async () => {
  let release!: () => void;
  const credentialsReady = new Promise<void>(resolve => { release = resolve; });
  const sign = createBedrockSigner({ credentials: async () => { await credentialsReady; return { accessKeyId: "FIXTURE_ACCESS", secretAccessKey: "fixture-secret" }; } });
  const body = new Uint8Array([1, 2, 3]);
  const pending = sign("https://bedrock-mantle.us-east-1.api.aws/v1/chat/completions", { method: "POST", body });
  body.fill(9); release();
  const request = await pending;
  const sent = Buffer.from(await request.arrayBuffer());
  assert.deepEqual([...sent], [1, 2, 3]);
  assert.equal(request.headers.get("x-amz-content-sha256"), createHash("sha256").update(sent).digest("hex"));
});

it("preserves normalized Request methods, headers and cancellation", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 8, 27) });
  const sign = createBedrockSigner({ credentials: async () => ({ accessKeyId: "FIXTURE_ACCESS", secretAccessKey: "fixture-secret" }) });
  const endpoint = "https://bedrock-mantle.us-east-1.api.aws/v1/models";
  const controller = new AbortController();
  const head = await sign(new Request(endpoint, { method: "HEAD", headers: { "x-probe": "retained" }, signal: controller.signal }));
  assert.equal(head.method, "HEAD"); assert.equal(head.headers.get("x-probe"), "retained");
  controller.abort(); assert.equal(head.signal.aborted, true);
  const first = await sign(endpoint, { method: "post", body: "{}" });
  const second = await sign(endpoint, { method: "POST", body: "{}" });
  assert.equal(first.headers.get("authorization"), second.headers.get("authorization"));
  const prototypeA = await sign(`${endpoint}?__proto__=one`), prototypeB = await sign(`${endpoint}?__proto__=two`);
  assert.notEqual(prototypeA.headers.get("authorization"), prototypeB.headers.get("authorization"));
  await assert.rejects(sign(new Request(endpoint, { method: "POST", body: "{}" })), { code: "unsupported_protocol" });
  await assert.rejects(sign(endpoint, { method: "POST", body: new FormData() }), { code: "unsupported_protocol" });
});
