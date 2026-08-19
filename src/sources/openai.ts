/**
 * OpenAI's `GET /v1/models` lists ids and nothing else — no price, no window
 * — so this source changes nothing. It exists to say when a registered model
 * is no longer served, which is the one thing about OpenAI's catalog that goes
 * stale silently.
 */

import type { Registry } from "../registry.ts";
import { fetchJson, type SourceResult } from "./types.ts";

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
  return body.data
    .map((entry) => (typeof entry === "object" && entry !== null ? (entry as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === "string");
}

export function checkOpenAi(registry: Registry, ids: string[]): SourceResult {
  const served = new Set(ids);
  const notes: string[] = [];
  for (const offering of registry.offerings) {
    if (offering.provider !== "openai" || offering.hidden) {
      continue;
    }
    if (!served.has(offering.wireId ?? offering.family)) {
      notes.push(`openai/${offering.family}: not in OpenAI's models catalog`);
    }
  }
  return { source: "OpenAI", changes: [], notes };
}
