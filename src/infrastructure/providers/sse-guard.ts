import type { Operation } from "../../domain/router/types.ts";
import type { createUsageObserver } from "./usage-observer.ts";

/** Platform limit for one SSE event, including its delimiters; not a provider limit. */
export const MAX_SSE_EVENT_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MAX_STREAM_BUFFER_BYTES = 256 * 1024 * 1024;
export const MAX_STREAM_BUFFER_BYTES = 1024 * 1024 * 1024;
const SMALL_CHUNK_BYTES = 4096;
const OUTPUT_BATCH_BYTES = 64 * 1024;
const EMPTY_BYTES = new Uint8Array(0);

/** One transport instance owns this process-wide payload budget across all its SSE streams. */
export class SseBufferBudget {
  private used = 0;
  readonly limit: number;
  constructor(limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("SSE buffer budget must be a positive integer");
    this.limit = limit;
  }
  get retainedBytes() { return this.used; }
  reserve(bytes: number): boolean {
    if (this.used + bytes > this.limit) return false;
    this.used += bytes;
    return true;
  }
  release(bytes: number) { this.used -= bytes; }
}

interface HeldChunk { bytes: Uint8Array; reserved: number }

/** Small upstream fragments share slabs rather than allocating one array entry per byte. */
class EventBytes {
  size = 0;
  private parts: Uint8Array[] = [];
  private tail: Uint8Array | undefined;
  private used = 0;
  private readonly budget: SseBufferBudget;
  constructor(budget: SseBufferBudget) { this.budget = budget; }

  append(bytes: Uint8Array, complete: boolean): "provider_event_too_large" | "provider_stream_capacity_exceeded" | undefined {
    if (this.size + bytes.byteLength > MAX_SSE_EVENT_BYTES) return "provider_event_too_large";
    if (!this.budget.reserve(bytes.byteLength)) return "provider_stream_capacity_exceeded";
    const whole = complete && this.size === 0;
    this.size += bytes.byteLength;
    if (whole || bytes.byteLength >= SMALL_CHUNK_BYTES) {
      this.flushTail();
      this.parts.push(bytes);
    } else {
      let offset = 0;
      while (offset < bytes.byteLength) {
        this.tail ??= new Uint8Array(SMALL_CHUNK_BYTES);
        const length = Math.min(bytes.byteLength - offset, this.tail.byteLength - this.used);
        this.tail.set(bytes.subarray(offset, offset + length), this.used);
        this.used += length; offset += length;
        if (this.used === this.tail.byteLength) this.flushTail();
      }
    }
  }
  private flushTail() {
    if (this.tail && this.used) this.parts.push(this.tail.subarray(0, this.used));
    this.tail = undefined; this.used = 0;
  }
  take(): Uint8Array[] {
    this.flushTail();
    const parts = this.parts;
    this.parts = []; this.size = 0;
    return parts;
  }
  discard() { this.budget.release(this.size); this.parts = []; this.tail = undefined; this.used = 0; this.size = 0; }
}

/** Do not reflect upstream diagnostic messages, codes, event names or additional fields. */
function safeError(operation: Operation): Uint8Array {
  const message = "Provider response was interrupted";
  const value = operation === "messages" || operation === "messages/count_tokens"
    ? { type: "error", error: { type: "api_error", message } }
    : operation === "responses"
      ? { type: "error", code: "provider_stream_failed", message, param: null }
      : operation === "generateContent" || operation === "streamGenerateContent"
        ? { error: { code: 502, status: "UNAVAILABLE", message } }
        : { error: { type: "provider_error", code: "provider_stream_failed", message } };
  return new TextEncoder().encode(`${operation === "messages" || operation === "messages/count_tokens" || operation === "responses" ? "event: error\n" : ""}data: ${JSON.stringify(value)}\n\n`);
}

/**
 * SSE consumers dispatch complete events. Hold only the current event until its bounded metadata
 * projection establishes that it is safe, then release its original bytes without JSON reserialization.
 * The response is never buffered as a whole and no content is written to disk.
 */
export async function* guardSse(
  source: AsyncIterable<Uint8Array>,
  observer: ReturnType<typeof createUsageObserver>,
  operation: Operation,
  budget: SseBufferBudget,
): AsyncGenerator<Uint8Array> {
  const event = new EventBytes(budget);
  let lineBytes = 0, skipLf = false, pendingBoundary = false;
  const failure = safeError(operation);
  let ready: HeldChunk[] = [], readyBytes = 0, stopped = false;
  function enqueue(bytes: Uint8Array, reserved = bytes.byteLength) {
    if (!bytes.byteLength) return;
    readyBytes += bytes.byteLength;
    const previous = ready.at(-1);
    // Adjacent verified events from one network chunk can be released in that same chunk.
    if (previous?.bytes.buffer === bytes.buffer && previous.bytes.byteOffset + previous.bytes.byteLength === bytes.byteOffset) {
      previous.bytes = new Uint8Array(bytes.buffer, previous.bytes.byteOffset, previous.bytes.byteLength + bytes.byteLength);
      previous.reserved += reserved;
    } else ready.push({ bytes, reserved });
  }
  function takeReady() { const parts = ready; ready = []; readyBytes = 0; return parts; }
  async function* emitReady() {
    const parts = takeReady();
    try {
      for (const part of parts) {
        try { yield part.bytes; }
        finally { budget.release(part.reserved); part.reserved = 0; part.bytes = EMPTY_BYTES; }
      }
    } finally { for (const part of parts) { budget.release(part.reserved); part.reserved = 0; part.bytes = EMPTY_BYTES; } }
  }
  async function append(bytes: Uint8Array, complete = false): Promise<boolean> {
    const problem = event.append(bytes, complete);
    if (problem) {
      event.discard(); observer.reject(problem); enqueue(failure, 0); stopped = true;
      return false;
    }
    await observer.write(bytes);
    return true;
  }
  function release() {
    const problem = observer.problem();
    if (problem) {
      event.discard();
      observer.reject(problem);
      enqueue(failure, 0); stopped = true;
    } else {
      for (const part of event.take()) enqueue(part);
      stopped = observer.result().complete;
    }
  }
  try { for await (const chunk of source) {
    let offset = 0, index = 0;
    let nextCr = chunk.indexOf(13), nextLf = chunk.indexOf(10);
    while (index < chunk.byteLength) {
      if (pendingBoundary) {
        const end = index + (chunk[index] === 10 ? 1 : 0);
        if (await append(chunk.subarray(offset, end), true)) release();
        if (stopped) { yield* emitReady(); return; }
        if (readyBytes >= OUTPUT_BATCH_BYTES) yield* emitReady();
        offset = end; index = end; pendingBoundary = false; skipLf = false;
        continue;
      }
      if (skipLf) { skipLf = false; if (chunk[index] === 10) { index++; continue; } }
      if (nextCr !== -1 && nextCr < index) nextCr = chunk.indexOf(13, index);
      if (nextLf !== -1 && nextLf < index) nextLf = chunk.indexOf(10, index);
      const newline = nextCr === -1 ? nextLf : nextLf === -1 ? nextCr : Math.min(nextCr, nextLf);
      if (newline === -1) { lineBytes += chunk.byteLength - index; break; }
      lineBytes += newline - index;
      index = newline + 1;
      const byte = chunk[newline]!;
      if (byte === 13) {
        pendingBoundary = lineBytes === 0;
        lineBytes = 0; skipLf = true;
      } else if (byte === 10) {
        if (lineBytes === 0) {
          if (await append(chunk.subarray(offset, index), true)) release();
          if (stopped) { yield* emitReady(); return; }
          if (readyBytes >= OUTPUT_BATCH_BYTES) yield* emitReady();
          offset = index;
        }
        lineBytes = 0;
      }
    }
    if (offset < chunk.byteLength) await append(chunk.subarray(offset));
    yield* emitReady();
    if (stopped) return;
  }
  await observer.end();
  if (event.size || observer.problem()) release();
  yield* emitReady();
  } finally {
    event.discard();
    for (const part of ready) { budget.release(part.reserved); part.bytes = EMPTY_BYTES; }
    ready = [];
  }
}
