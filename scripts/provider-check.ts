import { providerCredentialContext } from "../src/domain/router/validation.ts";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import type { RouterRepository, SecretCipher } from "../src/domain/router/repository.ts";
import type { Principal } from "../src/domain/router/types.ts";
import { createInference } from "../src/application/inference.ts";
import { createProviderTransport } from "../src/infrastructure/providers/transport.ts";

/** Real HTTP proves no redirects/replays and propagates consumer cancellation through fetch. */
export async function checkProviderHttp(repository: RouterRepository, cipher: SecretCipher): Promise<void> {
  let mode: "success" | "error" | "redirect" | "cancel" | "disconnect" = "success";
  let disconnectUpstream: (() => void) | undefined;
  let calls = 0;
  let credentialRecipientCalls = 0;
  let failure: unknown;
  let origin = "";
  let markDisconnected!: () => void;
  const disconnected = new Promise<void>(resolve => { markDisconnected = resolve; });
  const server = createServer(async (request, response) => {
    try {
      if (request.url === "/capture") { credentialRecipientCalls++; response.end("unexpected"); return; }
      calls++;
      assert.equal(request.url, "/v1/chat/completions");
      assert.equal(request.headers.authorization, "Bearer local-fixture-provider-key");
      assert.equal(request.headers.cookie, undefined);
      let raw = "";
      for await (const chunk of request) raw += String(chunk);
      const body = JSON.parse(raw);
      assert.equal(body.model, "upstream-model");
      assert.equal(body.stream_options.include_usage, true);
      if (mode === "redirect") { response.writeHead(307, { location: `${origin}/capture` }); response.end(); return; }
      if (mode === "error") {
        response.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
        response.end(JSON.stringify({ error: { message: "local-fixture-provider-key and private prompt" } })); return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"choices":[{"delta":{"content":"fixture"}}],"usage":{"prompt_tokens":7}}\n\n');
      if (mode === "cancel") { response.once("close", markDisconnected); return; }
      if (mode === "disconnect") { disconnectUpstream = () => response.destroy(); return; }
      response.end('data: {"usage":{"prompt_tokens":7,"completion_tokens":3}}\n\ndata: [DONE]\n\n');
    } catch (error) { failure = error; response.destroy(); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  origin = `http://127.0.0.1:${address.port}`;
  const principal: Principal = { subject: "http-fixture-user", kind: "user", service: "agent-studio", admin: false, canInvoke: true };
  try {
    const provider = { id: "http-fixture", name: "HTTP fixture", kind: "selfhosted" as const, auth: "secret" as const, enabled: true, baseUrl: `${origin}/v1` };
    await repository.saveProvider({ ...provider, encryptedSecret: cipher.encrypt("local-fixture-provider-key", providerCredentialContext(provider)) }, null);
    await repository.saveModel({ id: "http-fixture/model", providerId: "http-fixture", wireId: "upstream-model", displayName: "Fixture model",
      type: "text", contextWindow: 8192, maxTokens: 1024, pricing: { inputPer1M: 2, outputPer1M: 6 }, enabled: true,
      operations: ["chat/completions"], capabilities: { tools: true, structuredOutput: false, imageInput: false, reasoning: false } }, null);
    const inference = createInference({ repository, cipher, transport: createProviderTransport(), executionId: randomUUID, now: Date.now, monotonic: () => performance.now(), timeoutMs: 10_000, concurrencyLimit: 8 });
    const invoke = (id: string) => inference(principal, { requestId: id, modelId: "http-fixture/model", operation: "chat/completions",
      body: { kind: "json", value: { model: "caller-cannot-change-target", messages: [], stream: true } }, headers: { cookie: "not-forwarded" }, signal: new AbortController().signal });
    const success = await invoke("http-success");
    let output = "";
    for await (const chunk of success.body) output += new TextDecoder().decode(chunk);
    assert.ok(output.endsWith("data: [DONE]\n\n"));
    assert.equal((await repository.getUsage(principal.service, "http-success"))?.settlement?.costUsd, 0.000032);
    const semanticCompletion = await invoke("http-done");
    const doneIterator = semanticCompletion.body[Symbol.asyncIterator]();
    let seen = "";
    while (!seen.includes("[DONE]")) {
      const chunk = await doneIterator.next();
      assert.equal(chunk.done, false);
      seen += new TextDecoder().decode(chunk.value);
    }
    await doneIterator.return?.(undefined);
    const completedUsage = await repository.getUsage(principal.service, "http-done");
    assert.equal(completedUsage?.state, "succeeded", "an SDK stopping at DONE does not cancel completed inference");
    assert.equal(completedUsage.settlement?.costUsd, 0.000032);
    mode = "error";
    const error = await invoke("http-error");
    let errorBody = "";
    for await (const chunk of error.body) errorBody += new TextDecoder().decode(chunk);
    assert.equal(error.status, 429);
    assert.ok(!errorBody.includes("private prompt") && !errorBody.includes("local-fixture-provider-key"));
    assert.equal((await repository.getUsage(principal.service, "http-error"))?.state, "failed");
    mode = "redirect";
    await assert.rejects(invoke("http-redirect"), { code: "provider_unavailable" });
    assert.equal(credentialRecipientCalls, 0, "credentials never follow the redirect target");
    mode = "cancel";
    const cancel = await invoke("http-cancel");
    const iterator = cancel.body[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.(undefined);
    await disconnected;
    assert.equal((await repository.getUsage(principal.service, "http-cancel"))?.state, "cancelled");
    mode = "disconnect";
    const interrupted = await invoke("http-disconnect");
    const interruptedIterator = interrupted.body[Symbol.asyncIterator]();
    await interruptedIterator.next();
    assert.ok(disconnectUpstream);
    disconnectUpstream();
    await assert.rejects(interruptedIterator.next(), { code: "provider_stream_failed" });
    const interruptedUsage = await repository.getUsage(principal.service, "http-disconnect");
    assert.equal(interruptedUsage?.state, "failed");
    assert.equal(interruptedUsage.settlement?.errorCode, "provider_stream_failed", "cleanup abort is not a provider timeout");
    assert.equal(calls, 6, "one provider HTTP call per admitted request, including failures");
    assert.equal(failure, undefined);
    console.log("PASS Models provider HTTP: wire target, byte-preserving SSE, durable usage, sanitized error, no retry/redirect and upstream cancellation");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}
