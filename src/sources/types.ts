/**
 * What a live source reports back: the edits it made to the registry and the
 * things it noticed but left alone. Kept apart from the fetching so the apply
 * step can be tested on fixtures, with no network.
 */

export interface Change {
  /** `family <id>` or `offering <provider>/<family>`. */
  target: string;
  field: string;
  from: unknown;
  to: unknown;
}

export interface SourceResult {
  source: string;
  changes: Change[];
  /** Observations that need a person: an id the source no longer lists, a number the source disagrees on. */
  notes: string[];
}

/** A pricing key set compared as numbers, not object identity. */
export function samePricing(
  a: Record<string, number | undefined> | undefined,
  b: Record<string, number | undefined> | undefined,
): boolean {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  for (const key of keys) {
    if ((a ?? {})[key] !== (b ?? {})[key]) {
      return false;
    }
  }
  return true;
}

/** USD per million tokens, trimmed of float noise: 0.0000000826 $/token → 0.0826. */
export function perMillion(perToken: number): number {
  return Number((perToken * 1_000_000).toFixed(8));
}

export function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export function isExternalId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 300
    && /^[^\u0000-\u0020\u007f]+$/.test(value);
}

export const FETCH_TIMEOUT_MS = 30_000;
export const MAX_JSON_BYTES = 10 * 1024 * 1024;

async function readJson(response: Response, url: string): Promise<unknown> {
  const stated = Number(response.headers?.get("content-length"));
  if (stated > MAX_JSON_BYTES) {
    throw new Error(`GET ${url} → response is larger than ${MAX_JSON_BYTES} bytes`);
  }
  if (response.body === null || typeof response.body?.getReader !== "function") {
    return response.json();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_JSON_BYTES) {
      await reader.cancel();
      throw new Error(`GET ${url} → response is larger than ${MAX_JSON_BYTES} bytes`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export async function fetchJson(
  url: string,
  init: RequestInit,
  fetchFn: typeof fetch = fetch,
): Promise<unknown> {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const signal = init.signal == null ? timeout : AbortSignal.any([init.signal, timeout]);
  const response = await fetchFn(url, { ...init, redirect: "error", signal });
  if (!response.ok) {
    throw new Error(`GET ${url} → ${response.status} ${response.statusText}`);
  }
  return readJson(response, url);
}
