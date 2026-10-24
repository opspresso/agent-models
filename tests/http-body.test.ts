import assert from "node:assert/strict";
import { it } from "node:test";
import { boundedBytes, withInferenceBody } from "../src/lib/http.ts";

const request = (body: string) => new Request("http://localhost/v1/chat/completions", { method: "POST", body });
it("reserves aggregate input bytes before dispatch and releases rejected or completed reservations", async () => {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = withInferenceBody(request("123456"), 10, async bytes => { assert.equal(bytes.byteLength, 6); enter(); await gate; return true; });
  await entered;
  await assert.rejects(withInferenceBody(request("123456"), 10, async () => { throw new Error("must not dispatch"); }), { code: "body_capacity_exceeded" });
  release(); await first;
  assert.equal(await withInferenceBody(request("1234567890"), 10, async bytes => bytes.byteLength), 10);
  await assert.rejects(withInferenceBody(request("12345"), 10, async () => { throw new Error("fixture failure"); }), /fixture failure/);
  assert.equal(await withInferenceBody(request("1234567890"), 10, async bytes => bytes.byteLength), 10);
});
it("refuses a body larger than the declared limit", async () => {
  await assert.rejects(boundedBytes(request("12345"), 4), { code: "body_too_large" });
});
