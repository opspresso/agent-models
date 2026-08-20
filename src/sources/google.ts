/**
 * Google's Gemini API lists its models at `GET /v1beta/models` — name,
 * `inputTokenLimit`, `outputTokenLimit`, and which methods each supports — and
 * publishes no price, so pricing stays hand-kept against the pricing page.
 * Read when `GOOGLE_API_KEY` is set; without it Google's routes are not
 * watched, which README says.
 *
 * Names are `models/<id>`; the registry's family id is the `<id>`. Only a
 * model that answers `generateContent` is one a run can use.
 */

import type { Registry } from "../registry.ts";
import { observePresence, offeringNames } from "./presence.ts";
import { addRoute, familyHasRoute, familyIsLive } from "./routes.ts";
import { fetchJson, isPositiveInt, type Change, type SourceResult } from "./types.ts";

export const GOOGLE_MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const MAX_PAGES = 25;

export interface GoogleModel {
  name: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedGenerationMethods?: string[];
}

export async function fetchGoogleModels(apiKey: string, fetchFn: typeof fetch = fetch): Promise<GoogleModel[]> {
  const collected: GoogleModel[] = [];
  let token: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = `${GOOGLE_MODELS_URL}?pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`;
    const body = (await fetchJson(url, { headers: { "x-goog-api-key": apiKey } }, fetchFn)) as {
      models?: unknown;
      nextPageToken?: unknown;
    };
    if (!Array.isArray(body.models)) {
      throw new Error(`GET ${GOOGLE_MODELS_URL} → no "models" array`);
    }
    collected.push(...(body.models as GoogleModel[]));
    if (typeof body.nextPageToken !== "string" || body.nextPageToken === "") {
      if (collected.length === 0) {
        throw new Error(`GET ${GOOGLE_MODELS_URL} → empty catalog`);
      }
      return collected;
    }
    token = body.nextPageToken;
  }
  throw new Error(`GET ${GOOGLE_MODELS_URL} → still paginating after ${MAX_PAGES} pages`);
}

function usable(model: GoogleModel): boolean {
  const methods = model.supportedGenerationMethods ?? [];
  return methods.includes("generateContent") || methods.includes("predict");
}

function byFamilyId(catalog: GoogleModel[]): Map<string, GoogleModel> {
  const map = new Map<string, GoogleModel>();
  for (const model of catalog) {
    if (usable(model)) {
      map.set(model.name.replace(/^models\//, ""), model);
    }
  }
  return map;
}

export function applyGoogle(
  registry: Registry,
  catalog: GoogleModel[],
  today: string,
): { registry: Registry; result: SourceResult } {
  const next = structuredClone(registry);
  const changes: Change[] = [];
  const notes: string[] = [];
  const byId = byFamilyId(catalog);
  for (const offering of next.offerings) {
    if (offering.provider !== "google" || offering.hidden) {
      continue;
    }
    const family = next.families[offering.family];
    if (family === undefined) {
      continue;
    }
    const entry = offeringNames(offering)
      .map((name) => byId.get(name))
      .find((candidate) => candidate !== undefined);
    observePresence(offering, entry !== undefined, "Google", today, changes, notes);
    if (entry === undefined || family.capabilities.imageGeneration) {
      continue;
    }
    const window = entry.inputTokenLimit;
    const maxOut = entry.outputTokenLimit;
    if (isPositiveInt(window) && window !== family.contextWindow) {
      changes.push({ target: `family ${offering.family}`, field: "contextWindow", from: family.contextWindow, to: window });
      family.contextWindow = window;
    }
    if (isPositiveInt(maxOut) && maxOut !== family.maxTokens) {
      if (maxOut > family.contextWindow) {
        notes.push(`google/${offering.family}: Google states outputTokenLimit ${maxOut} above the ${family.contextWindow} window; left alone`);
      } else {
        changes.push({ target: `family ${offering.family}`, field: "maxTokens", from: family.maxTokens, to: maxOut });
        family.maxTokens = maxOut;
      }
    }
  }
  return { registry: next, result: { source: "Google", changes, notes } };
}

/** A `google/` route for every live Google-made text family the API serves under the family's id. */
export function discoverGoogle(registry: Registry, catalog: GoogleModel[]): { registry: Registry; result: SourceResult } {
  const next = structuredClone(registry);
  const changes: Change[] = [];
  const byId = byFamilyId(catalog);
  for (const [id, family] of Object.entries(next.families)) {
    if (family.maker !== "google" || family.capabilities.imageGeneration) {
      continue;
    }
    if (familyHasRoute(next, id, "google") || !familyIsLive(next, id) || !byId.has(id)) {
      continue;
    }
    addRoute(next, { provider: "google", family: id }, changes);
  }
  return { registry: next, result: { source: "Google", changes, notes: [] } };
}
