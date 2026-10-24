import assert from "node:assert/strict";
import { it } from "node:test";
import { assertIndependentContext, assertIndependentMultipartContext } from "../src/domain/router/request-policy.ts";
import type { Operation } from "../src/domain/router/types.ts";

const remote: Array<[Operation, Record<string, unknown>]> = [
  ["chat/completions", { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "http://private.internal/image" } }] }] }],
  ["responses", { input: [{ role: "user", content: [{ type: "input_image", image_url: "https://remote.test/image" }] }] }],
  ["responses", { input: [{ role: "user", content: [{ type: "input_file", file_url: "https://remote.test/file.pdf" }] }] }],
  ["messages", { messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url: "https://remote.test/image" } }] }] }],
  ["images", { input_references: [{ type: "image_url", image_url: { url: "http://private.internal/image" } }] }],
  ["images/edits", { images: [{ url: "http://private.internal/image" }] }],
  ["audio/transcriptions", { file: "https://remote.test/recording.wav" }],
  ["embeddings", { images: ["https://remote.test/image"] }],
];
it("accepts caller-executed custom tools, including namespace members, while refusing hosted tools", () => {
  const custom = { type: "custom", name: "apply_patch", format: { type: "grammar", syntax: "lark", definition: 'start: "patch"' } };
  for (const tool of [custom, { type: "namespace", name: "functions", description: "Caller tools", tools: [custom] }]) {
    assert.doesNotThrow(() => assertIndependentContext({ tools: [tool], input: [{ type: "custom_tool_call_output", call_id: "call-1", output: "Completed locally" }] }, "responses"));
  }
  assert.throws(() => assertIndependentContext({ tools: [{ type: "namespace", name: "hosted", tools: [{ type: "file_search", vector_store_ids: ["private"] }] }] }, "responses"), { code: "provider_state_forbidden" });
});
for (const [index, [operation, body]] of remote.entries()) {
  it(`refuses provider-side media fetching for ${operation} case ${index}`, () => {
    assert.throws(() => assertIndependentContext(body, operation), { code: "provider_state_forbidden" });
  });
}
it("preserves inline media, URL text and tool schemas as caller data", () => {
  const image = "data:image/png;base64,AQID";
  assert.doesNotThrow(() => assertIndependentContext({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: image } }, { type: "text", text: "Explain https://example.test" }] }],
    tools: [{ type: "function", function: { name: "inspect", parameters: { type: "object", properties: { file_url: { type: "string" } } } } }] }, "chat/completions"));
  assert.doesNotThrow(() => assertIndependentContext({ input: [{ type: "function_call_output", call_id: "tool-1", output: '{"file_url":"https://example.test"}' }] }, "responses"));
  assert.doesNotThrow(() => assertIndependentContext({ images: [{ url: image }], mask: { url: image } }, "images/edits"));
  assert.doesNotThrow(() => assertIndependentContext({ messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } }] }] }, "messages"));
});
it("requires actual multipart media bytes while preserving ordinary text fields", () => {
  assert.throws(() => assertIndependentMultipartContext([{ name: "file", value: "https://remote.test/recording.wav" }], "audio/transcriptions"), { code: "inline_media_required" });
  assert.throws(() => assertIndependentMultipartContext([{ name: "image[]", value: "file-account-owned" }], "images/edits"), { code: "inline_media_required" });
  assert.throws(() => assertIndependentMultipartContext([{ name: "image_url[]", value: "https://remote.test/image" }, { name: "image_url[]", value: "data:image/png;base64,AQID" }], "images/edits"), { code: "provider_state_forbidden" });
  assert.doesNotThrow(() => assertIndependentMultipartContext([{ name: "file", value: new Uint8Array([1, 2, 3]) }, { name: "prompt", value: "Explain https://example.test" }], "audio/transcriptions"));
});
