import { RouterError } from "../../domain/router/errors.ts";
import { assertIndependentContext } from "../../domain/router/request-policy.ts";
import type { InferenceTransport } from "../../domain/router/transport.ts";
import type { Operation, Provider } from "../../domain/router/types.ts";
import { providerUrl } from "../../domain/router/validation.ts";
import { createUsageObserver } from "./usage-observer.ts";
import type { RequestSigner } from "./bedrock-signer.ts";

export function providerEndpoint(provider: Provider, operation: Operation, wireId: string): string {
  let base = providerUrl(provider.baseUrl);
  if (operation === "generateContent" || operation === "streamGenerateContent") {
    base = base.replace(/\/openai$/, "");
    const endpoint = `${base}/models/${encodeURIComponent(wireId.replace(/^models\//, ""))}:${operation}`;
    return operation === "streamGenerateContent" ? `${endpoint}?alt=sse` : endpoint;
  }
  if (operation === "decisions") {
    if (provider.kind === "openrouter") return `${base.replace(/\/v1$/, "")}/alpha/decisions`;
    if (provider.kind === "selfhosted") return `${base}${base.endsWith("/v1") ? "" : "/v1"}/systemone`;
    throw new RouterError("unsupported_protocol", 400, "This provider does not support decisions");
  }
  if (provider.kind === "google" && !base.endsWith("/openai")) base += "/openai";
  return `${base}/${operation}`;
}

/** Forward the selected wire protocol with one credential source and a bounded usage observer. */
export function createProviderTransport(options: { request?: typeof fetch; signer?: RequestSigner } = {}): InferenceTransport {
  return {
    async execute(input) {
      const request = options.request ?? fetch;
      if (input.provider.auth === "sigv4" && !options.signer) throw new RouterError("signing_unavailable", 503, "AWS request signing is not configured");
      const endpoint = providerEndpoint(input.provider, input.operation, input.model.wireId);
      const headers = new Headers();
      for (const name of ["anthropic-version", "anthropic-beta", "openai-beta"]) {
        const value = input.headers[name];
        if (value !== undefined) {
          if (value.length > 512 || /[\r\n]/.test(value)) throw new RouterError("invalid_header", 400, "Invalid provider protocol header");
          headers.set(name, value);
        }
      }
      const messages = input.operation === "messages" || input.operation === "messages/count_tokens";
      const googleNative = input.operation === "generateContent" || input.operation === "streamGenerateContent";
      if (messages && !headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
      if (input.provider.auth === "secret") {
        if (!input.secret) throw new RouterError("credential_required", 503, "Provider credential is unavailable");
        if (messages) headers.set("x-api-key", input.secret);
        else if (input.provider.kind === "google" && googleNative) headers.set("x-goog-api-key", input.secret);
        else headers.set("authorization", `Bearer ${input.secret}`);
      }
      let body: string | FormData;
      let inputImages: number | undefined;
      if (input.body.kind === "json") {
        assertIndependentContext(input.body.value, input.operation);
        const { model: _model, ...value } = input.body.value;
        if (input.model.type === "image") {
          if (input.operation === "images") inputImages = Array.isArray(value.input_references) ? value.input_references.length : value.input_references == null ? 0 : undefined;
          if (input.operation === "images/generations" || input.operation === "images/edits") {
            inputImages = Array.isArray(value.images) ? value.images.length : value.image != null ? 1 : value.images == null ? 0 : undefined;
          }
        }
        if (input.operation === "responses") value.store = false;
        if (input.operation === "chat/completions" && value.stream === true) {
          const streamOptions = value.stream_options && typeof value.stream_options === "object" && !Array.isArray(value.stream_options) ? value.stream_options : {};
          value.stream_options = { ...streamOptions, include_usage: true };
        }
        body = JSON.stringify({ ...value, ...(!googleNative ? { model: input.model.wireId } : {}) });
        headers.set("content-type", "application/json");
      } else {
        if (!["images/edits", "audio/transcriptions"].includes(input.operation)) throw new RouterError("invalid_multipart", 400, "This operation does not accept multipart input");
        if (input.provider.auth === "sigv4") throw new RouterError("unsupported_protocol", 400, "SigV4 multipart inference is not supported");
        const form = new FormData();
        if (input.model.type === "image") inputImages = input.body.parts.filter(part => /^image(?:\[\d*\])?$/.test(part.name)).length;
        for (const part of input.body.parts) {
          if (part.name === "model") continue;
          if (typeof part.value === "string") form.append(part.name, part.value);
          else form.append(part.name, new Blob([new Uint8Array(part.value)], { type: part.contentType ?? "application/octet-stream" }), part.filename ?? "input");
        }
        form.set("model", input.model.wireId);
        body = form;
      }
      const requestInit = { method: "POST", headers, body, signal: input.signal, redirect: "error" as const };
      const prepared = input.provider.auth === "sigv4" ? await options.signer!(endpoint, requestInit) : undefined;
      input.onDispatch();
      const response = prepared ? await request(prepared, { signal: input.signal, redirect: "error" }) : await request(endpoint, requestInit);
      const outgoing: Record<string, string> = { "cache-control": "no-store", "x-accel-buffering": "no" };
      for (const name of ["content-type", "x-request-id", "request-id", "x-amzn-requestid", "retry-after"]) {
        const value = response.headers.get(name);
        if (value) outgoing[name] = value;
      }
      if (!response.ok) {
        await response.body?.cancel();
        outgoing["content-type"] = "application/json";
        const payload = new TextEncoder().encode(JSON.stringify({ error: { message: "Provider request failed", type: "provider_error", code: "provider_http_error" } }));
        return { status: response.status, headers: outgoing, body: (async function* () { yield payload; })(),
          observation: () => ({ amounts: {}, measurement: "unavailable", complete: true, errorCode: "provider_http_error" }) };
      }
      const observer = createUsageObserver(input.operation, input.provider.kind, input.model.type, response.headers.get("content-type")?.includes("text/event-stream") ?? false);
      async function* stream() {
        if (!response.body) { await observer.end(); return; }
        const reader = response.body.getReader();
        let ended = false;
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) { await observer.end(); ended = true; break; }
            await observer.write(chunk.value);
            yield chunk.value;
          }
        } finally {
          observer.cancel();
          try { if (!ended) await reader.cancel(); }
          finally { reader.releaseLock(); }
        }
      }
      return { status: response.status, headers: outgoing, body: stream(), observation: () => {
        const result = observer.result();
        if (inputImages !== undefined) result.amounts.inputImages = inputImages;
        return result;
      } };
    },
  };
}
