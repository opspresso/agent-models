/**
 * OpenAI's `GET /v1/models` lists ids and nothing else — no price, no window
 * — so this source moves no number. It exists to notice when a registered
 * model is no longer served, which is the one thing about OpenAI's catalog
 * that goes stale silently; the retirement itself follows `presence.ts`.
 */

import type { Registry } from "../registry.ts";
import { observePresence } from "./presence.ts";
import { fetchJson, type Change, type SourceResult } from "./types.ts";

export const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";

export async function fetchOpenAiModelIds(apiKey: string, fetchFn: typeof fetch = fetch): Promise<string[]> {
  const body = (await fetchJson(
    OPENAI_MODELS_URL,
    { headers: { Authorization: `Bearer ${apiKey}` } },
    fetchFn,
  )) as { data?: unknown };
  if (!Array.isArray(body.data)) {
    throw new Error(`GET ${OPENAI_MODELS_URL} → no "data" array`);
  }
  const ids = body.data
    .map((entry) => (typeof entry === "object" && entry !== null ? (entry as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === "string");
  if (ids.length === 0) {
    throw new Error(`GET ${OPENAI_MODELS_URL} → empty catalog`);
  }
  return ids;
}

export function applyOpenAi(
  registry: Registry,
  ids: string[],
  today: string,
): { registry: Registry; result: SourceResult } {
  const next = structuredClone(registry);
  const served = new Set(ids);
  const changes: Change[] = [];
  const notes: string[] = [];
  for (const offering of next.offerings) {
    if (offering.provider !== "openai" || offering.hidden) {
      continue;
    }
    observePresence(offering, served.has(offering.wireId ?? offering.family), "OpenAI", today, changes, notes);
  }
  return { registry: next, result: { source: "OpenAI", changes, notes } };
}
