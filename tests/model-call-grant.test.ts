import assert from "node:assert/strict";
import { test } from "node:test";
import { modelCallGrant } from "../src/domain/identity.ts";

test("signed invocation grants are versioned, bounded and do not coerce caller input", () => {
  const grant = { version: 1, requestId: "request-1", modelId: "local/model", operation: "chat/completions", agentId: "agent-1" };
  assert.deepEqual(modelCallGrant(grant), grant);
  assert.equal(modelCallGrant(undefined), undefined);
  for (const value of [null, [], "grant", {}, { ...grant, version: 2 }, { ...grant, requestId: 1 }, { ...grant, modelId: "model with space" },
    { ...grant, operation: "files" }, { ...grant, agentId: "\nother" }, { ...grant, userId: "other" }, { ...grant, requestId: "a".repeat(201) }]) {
    assert.throws(() => modelCallGrant(value), { code: "invalid_grant" });
  }
});
