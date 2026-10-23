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
