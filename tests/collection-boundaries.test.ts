import assert from "node:assert/strict";
import { it } from "node:test";
import { jsonBody } from "../src/lib/http.ts";
import { modelInput } from "../src/lib/schemas.ts";

it("bounds validation work for an oversized collection inside the management body limit", async () => {
  const model = { id: "fixture", providerId: "fixture", wireId: "fixture", displayName: "Fixture", type: "text",
    contextWindow: 1024, maxTokens: 128, enabled: true, pricing: null,
    capabilities: { tools: false, structuredOutput: false, imageInput: false, reasoning: false } };
  assert.equal(modelInput.safeParse({ revision: null, model: { ...model, operations: ["chat/completions"] } }).success, true);
  const body = JSON.stringify({ revision: null, model: { ...model, operations: Array(10_000).fill(null) } });
  assert.ok(Buffer.byteLength(body) < 64 * 1024);
  const parsed = modelInput.safeParse(await jsonBody(new Request("http://localhost/api/models", { method: "PUT", body })));
  assert.equal(parsed.success, false);
  if (!parsed.success) {
    assert.equal(parsed.error.issues.length, 1);
    assert.equal(parsed.error.issues[0]!.code, "too_big");
    assert.ok(Buffer.byteLength(JSON.stringify(parsed.error.issues)) < 1024);
  }
});
