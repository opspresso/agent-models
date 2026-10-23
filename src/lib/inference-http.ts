import { randomUUID } from "node:crypto";
import { RouterError } from "../domain/router/errors.ts";
import { OPERATIONS, type Operation } from "../domain/router/types.ts";
import type { InferenceBody } from "../domain/router/transport.ts";
import { authorize, withInferenceBody } from "./http.ts";

export async function inferenceResponse(request: Request, path: string): Promise<Response> {
  const { app, principal } = await authorize(request, "models:invoke");
  if (!OPERATIONS.includes(path as Operation)) throw new RouterError("operation_not_found", 404, "Inference operation is not supported");
  const operation = path as Operation;
  return withInferenceBody(request, app.config.maxRequestBytes, async bytes => {
    const contentType = request.headers.get("content-type") ?? "";
    let body: InferenceBody;
    let modelId: string;
    if (contentType.startsWith("multipart/form-data")) {
      const form = await new Response(bytes, { headers: { "content-type": contentType } }).formData();
      const model = form.get("model");
      if (typeof model !== "string") throw new RouterError("invalid_model", 400, "A selected model ID is required");
      modelId = model;
      const parts: Extract<InferenceBody, { kind: "multipart" }>["parts"] = [];
      for (const [name, value] of form) parts.push(typeof value === "string" ? { name, value } : {
        name, value: new Uint8Array(await value.arrayBuffer()), filename: value.name, contentType: value.type,
      });
      body = { kind: "multipart", parts };
    } else {
      let value: unknown;
      try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
      catch { throw new RouterError("invalid_json", 400, "Invalid inference JSON"); }
      if (!value || typeof value !== "object" || Array.isArray(value) || !("model" in value) || typeof value.model !== "string") throw new RouterError("invalid_model", 400, "A selected model ID is required");
      modelId = value.model;
      body = { kind: "json", value: value as Record<string, unknown> };
    }
    const result = await app.inference(principal, { requestId: request.headers.get("idempotency-key") ?? request.headers.get("x-request-id") ?? randomUUID(),
      modelId, operation, body, headers: Object.fromEntries(request.headers), signal: request.signal });
    const iterator = result.body[Symbol.asyncIterator]();
    const output = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try { const next = await iterator.next(); if (next.done) controller.close(); else controller.enqueue(next.value); }
        catch (error) { controller.error(error); }
      },
      async cancel() { await iterator.return?.(undefined); },
    });
    const headers = new Headers(result.headers);
    if (headers.has("x-request-id")) headers.set("x-upstream-request-id", headers.get("x-request-id")!);
    headers.set("x-request-id", result.requestId);
    return new Response(output, { status: result.status, headers });
  });
}
