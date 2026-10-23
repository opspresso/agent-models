import type { ModelScope } from "../domain/identity.ts";
import { requireScope } from "../domain/identity.ts";
import { RouterError, isRouterError } from "../domain/router/errors.ts";
import { runtime } from "./runtime.ts";

export async function authorize(request: Request, scope: ModelScope, admin = false) {
  const app = await runtime();
  const authorization = request.headers.get("authorization");
  let principal;
  if (authorization !== null) {
    const bearer = /^Bearer ([^\s]+)$/i.exec(authorization);
    if (!bearer) throw new RouterError("unauthorized", 401, "Bearer authentication is required");
    principal = await app.studio.bearer(bearer[1]!);
  } else {
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && request.headers.get("origin") !== app.config.authBaseUrl) {
      throw new RouterError("invalid_origin", 403, "Cross-origin mutation refused");
    }
    principal = await app.session(request.headers);
    if (!principal) throw new RouterError("unauthorized", 401, "Sign in with Studio");
  }
  requireScope(principal, scope);
  if (admin && !principal.admin) throw new RouterError("admin_required", 403, "Administrator access is required");
  return { app, principal };
}

export function errorResponse(error: unknown): Response {
  if (isRouterError(error)) return Response.json({ error: { code: error.code, message: error.message } }, {
    status: error.status, headers: { "cache-control": "no-store", ...(error.status === 401 ? { "www-authenticate": "Bearer" } : {}), ...(error.status === 429 ? { "retry-after": "1" } : {}) },
  });
  console.error(JSON.stringify({ event: "models_request_failed" }));
  return Response.json({ error: { code: "service_unavailable", message: "The service could not complete this request" } }, { status: 503, headers: { "cache-control": "no-store" } });
}

export async function boundedBytes(request: Request, maxBytes: number, retain?: (bytes: number) => void): Promise<Uint8Array<ArrayBuffer>> {
  if (!request.body) throw new RouterError("invalid_body", 400, "Request body is required");
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxBytes) throw new RouterError("body_too_large", 413, "Request body exceeds its size limit");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0, ended = false;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) { ended = true; break; }
      size += chunk.value.byteLength;
      if (size > maxBytes) throw new RouterError("body_too_large", 413, "Request body exceeds its size limit");
      retain?.(chunk.value.byteLength);
      chunks.push(chunk.value);
    }
    const buffer = Buffer.concat(chunks);
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  } finally {
    try { if (!ended) await reader.cancel(); }
    finally { reader.releaseLock(); }
  }
}

const BODY_BUDGET = Symbol.for("opspresso.agent-models.body-budget");
const state = globalThis as typeof globalThis & { [BODY_BUDGET]?: { bytes: number } };
/** All inference bodies share one process budget until dispatch, before the DB execution gate opens. */
export async function withInferenceBody<T>(request: Request, limit: number, use: (bytes: Uint8Array<ArrayBuffer>) => Promise<T>): Promise<T> {
  const budget = state[BODY_BUDGET] ??= { bytes: 0 };
  let retained = 0;
  try {
    const bytes = await boundedBytes(request, limit, size => {
      if (budget.bytes + size > limit) throw new RouterError("body_capacity_exceeded", 429, "Inference input capacity is busy");
      budget.bytes += size; retained += size;
    });
    return await use(bytes);
  } finally { budget.bytes -= retained; }
}

export async function jsonBody(request: Request, maxBytes = 64 * 1024): Promise<unknown> {
  const bytes = await boundedBytes(request, maxBytes);
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new RouterError("invalid_json", 400, "Invalid JSON request"); }
}
