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

export async function fetchJson(
  url: string,
  init: RequestInit,
  fetchFn: typeof fetch = fetch,
): Promise<unknown> {
  const response = await fetchFn(url, init);
  if (!response.ok) {
    throw new Error(`GET ${url} → ${response.status} ${response.statusText}`);
  }
  return response.json();
}
