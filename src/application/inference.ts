import { RouterError, isRouterError } from "../domain/router/errors.ts";
import { priceUsage } from "../domain/router/pricing.ts";
import type { RouterRepository, SecretCipher } from "../domain/router/repository.ts";
import type { InferenceBody, InferenceTransport } from "../domain/router/transport.ts";
import type { Admission, Operation, Principal, Settlement } from "../domain/router/types.ts";
import { validIdentifier } from "../domain/router/validation.ts";

export interface InferenceDependencies {
  repository: RouterRepository;
  cipher: SecretCipher;
  transport: InferenceTransport;
  executionId(): string;
  now(): number;
  monotonic(): number;
  timeoutMs: number;
  concurrencyLimit: number;
}

/** Dispatch and accounting share one owner; paid work has no automatic replay path. */
export function createInference(deps: InferenceDependencies) {
  if (!Number.isSafeInteger(deps.timeoutMs) || deps.timeoutMs < 1 || !Number.isSafeInteger(deps.concurrencyLimit) || deps.concurrencyLimit < 1) {
    throw new Error("Inference timeout and concurrency limit must be positive integers");
  }
  return async (principal: Principal, input: {
    requestId: string; modelId: string; operation: Operation; body: InferenceBody;
    headers?: Readonly<Record<string, string>>; signal: AbortSignal;
  }) => {
    const { requestId, modelId, operation, signal: incomingSignal } = input;
    if (!principal.canInvoke) throw new RouterError("execution_forbidden", 403, "This account cannot invoke models");
    if (!validIdentifier(requestId) || !validIdentifier(modelId)) throw new RouterError("invalid_request", 400, "Invalid request or model ID");
    if (principal.modelCall && (principal.modelCall.requestId !== requestId || principal.modelCall.modelId !== modelId || principal.modelCall.operation !== operation)) {
      throw new RouterError("invocation_grant_mismatch", 403, "This credential authorizes a different model request");
    }
    if (incomingSignal.aborted) throw new RouterError("request_cancelled", 499, "Request was cancelled before admission");
    const started = deps.now();
    const startedMonotonic = deps.monotonic();
    const duration = () => Math.max(0, deps.monotonic() - startedMonotonic);
    const admission: Admission = {
      requestId: requestId, modelId: modelId, operation: operation, principal,
      executionId: deps.executionId(), deadlineAt: new Date(started + deps.timeoutMs).toISOString(),
    };
    const routed = await deps.repository.admit(admission, deps.concurrencyLimit);
    const controller = new AbortController();
    const remaining = Math.max(0, Math.ceil(deps.timeoutMs - duration()));
    const deadline = AbortSignal.timeout(remaining);
    const signal = AbortSignal.any([incomingSignal, controller.signal, deadline]);
    const settle = (value: Settlement) => deps.repository.settle(principal.service, requestId, admission.executionId, value);
    let dispatched = false;
    let response: Awaited<ReturnType<InferenceTransport["execute"]>>;
    try {
      const secret = routed.provider.encryptedSecret ? deps.cipher.decrypt(routed.provider.encryptedSecret, routed.provider.id) : null;
      if (signal.aborted || remaining === 0) throw new RouterError(incomingSignal.aborted ? "request_cancelled" : "provider_timeout", incomingSignal.aborted ? 499 : 504, "Request expired before dispatch");
      response = await deps.transport.execute({ model: routed.model, provider: routed.provider, secret,
        operation: operation, body: input.body, headers: input.headers ?? {}, signal, onDispatch: () => { dispatched = true; } });
    } catch (error) {
      const cancelled = incomingSignal.aborted;
      await settle({ outcome: cancelled ? "cancelled" : "failed", measurement: dispatched ? "unavailable" : "not_started", amounts: {},
        costUsd: dispatched ? null : 0, costSource: dispatched ? "unknown" : "not_started", httpStatus: null,
        errorCode: isRouterError(error) ? error.code : cancelled ? "request_cancelled" : deadline.aborted ? "provider_timeout" : dispatched ? "provider_unavailable" : "credential_unavailable",
        responseBytes: 0, durationMs: duration() });
      if (isRouterError(error)) throw error;
      throw new RouterError(cancelled ? "request_cancelled" : deadline.aborted ? "provider_timeout" : "provider_unavailable", cancelled ? 499 : deadline.aborted ? 504 : 502, "Provider request could not complete");
    }
    async function* body(): AsyncGenerator<Uint8Array> {
      let exhausted = false;
      let bytes = 0;
      let failed = false;
      try {
        for await (const chunk of response.body) {
          bytes += chunk.byteLength;
          yield chunk;
        }
        exhausted = true;
      } catch {
        failed = !response.observation().complete;
        if (failed) throw new RouterError("provider_stream_failed", 502, "Provider response was interrupted");
      } finally {
        if (!exhausted) controller.abort();
        const observed = response.observation();
        const httpOk = response.status >= 200 && response.status < 300;
        // SDKs close the HTTP stream as soon as DONE/completed arrives. That is
        // successful protocol completion, even when transport EOF was not read.
        const cancelled = !observed.complete && (incomingSignal.aborted || (!exhausted && !failed));
        const measurement = observed.measurement === "reported" && !observed.complete ? "partial" : observed.measurement;
        await settle({
          outcome: cancelled ? "cancelled" : failed || !httpOk || observed.errorCode ? "failed" : !observed.complete ? "unknown" : "succeeded",
          measurement, amounts: observed.amounts, ...priceUsage(routed.model.type, routed.model.pricing, observed.amounts, measurement),
          httpStatus: response.status, errorCode: observed.errorCode ?? (cancelled ? "request_cancelled" : deadline.aborted && !observed.complete ? "provider_timeout" : failed ? "provider_stream_failed" : !httpOk ? "provider_http_error" : !observed.complete ? "incomplete_response" : null),
          responseBytes: bytes, durationMs: duration(),
        });
      }
    }
    return { status: response.status, headers: response.headers, requestId: requestId, body: body() };
  };
}
