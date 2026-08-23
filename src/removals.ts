import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Registry } from "./registry.ts";

export interface RemovalRequest {
  id: string;
  reason: string;
  requestedAt: string;
}

export interface RemovalCandidate {
  id: string;
  reason: string;
}

function isUtcDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

export function loadRemovalManifest(root: string): RemovalRequest[] {
  const path = join(root, "models", "removals.json");
  if (!existsSync(path)) return [];
  const value = JSON.parse(readFileSync(path, "utf-8")) as unknown;
  if (!Array.isArray(value)) throw new Error("models/removals.json must be an array");
  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`models/removals.json[${index}] must be an object`);
    }
    const row = entry as Record<string, unknown>;
    const unknown = Object.keys(row).filter((key) => !["id", "reason", "requestedAt"].includes(key));
    if (unknown.length > 0) throw new Error(`models/removals.json[${index}] has unknown field "${unknown[0]}"`);
    if (typeof row.id !== "string" || !/^[a-z0-9._-]+\/[a-z0-9._-]+$/.test(row.id)) {
      throw new Error(`models/removals.json[${index}].id must be provider/family`);
    }
    if (seen.has(row.id)) throw new Error(`models/removals.json repeats "${row.id}"`);
    seen.add(row.id);
    if (typeof row.reason !== "string" || row.reason.trim() === "") {
      throw new Error(`models/removals.json[${index}].reason is required`);
    }
    if (!isUtcDate(row.requestedAt)) {
      throw new Error(`models/removals.json[${index}].requestedAt must be a valid UTC date`);
    }
  }
  return value as RemovalRequest[];
}

export function unrequestedRemovals(
  previousIds: readonly string[],
  nextIds: readonly string[],
  requests: readonly RemovalRequest[],
): string[] {
  const next = new Set(nextIds);
  const requested = new Set(requests.map(({ id }) => id));
  return previousIds.filter((id) => !next.has(id) && !requested.has(id));
}

export function assertRemovalPolicy(
  previousIds: readonly string[],
  nextIds: readonly string[],
  requests: readonly RemovalRequest[],
  pullRequest: boolean,
): void {
  const next = new Set(nextIds);
  const removed = previousIds.filter((id) => !next.has(id));
  if (removed.length === 0) return;
  if (!pullRequest) {
    throw new Error(`published model removals are allowed only through a pull request: ${removed.join(", ")}`);
  }
  const unrequested = unrequestedRemovals(previousIds, nextIds, requests);
  if (unrequested.length > 0) {
    throw new Error(
      `published model removal(s) without a removal request: ${unrequested.join(", ")} — add exact entries to models/removals.json`,
    );
  }
}

export function findRemovalCandidates(
  registry: Registry,
  requests: readonly RemovalRequest[],
): RemovalCandidate[] {
  const requested = new Set(requests.map(({ id }) => id));
  return registry.offerings.flatMap((offering) => {
    const id = `${offering.provider}/${offering.family}`;
    if (!offering.hidden || requested.has(id)) return [];
    if (offering.hiddenReason === "catalog") {
      return [{ id, reason: "Absent from the provider catalog after its grace period" }];
    }
    if (offering.hiddenReason === "ranking") {
      return [{ id, reason: "Outside the OpenRouter ranking policy after its grace period" }];
    }
    return [];
  });
}

export function applyRemovalCandidates(
  registry: Registry,
  candidates: readonly RemovalCandidate[],
  requests: readonly RemovalRequest[],
  requestedAt: string,
): { registry: Registry; requests: RemovalRequest[] } {
  if (!isUtcDate(requestedAt)) throw new Error("removal request date must be a valid UTC date");
  const existing = new Set(requests.map(({ id }) => id));
  const candidateIds = new Set<string>();
  for (const candidate of candidates) {
    if (candidateIds.has(candidate.id)) throw new Error(`removal candidate repeats "${candidate.id}"`);
    candidateIds.add(candidate.id);
    if (existing.has(candidate.id)) throw new Error(`removal request already exists for "${candidate.id}"`);
    const offering = registry.offerings.find(({ provider, family }) => `${provider}/${family}` === candidate.id);
    if (offering === undefined || !offering.hidden || !["catalog", "ranking"].includes(offering.hiddenReason ?? "")) {
      throw new Error(`${candidate.id} is not an automatically hidden offering`);
    }
  }
  const offerings = registry.offerings.filter(({ provider, family }) => !candidateIds.has(`${provider}/${family}`));
  const routed = new Set(offerings.map(({ family }) => family));
  const families = Object.fromEntries(Object.entries(registry.families).filter(([id]) => routed.has(id)));
  return {
    registry: { ...registry, families, offerings },
    requests: [
      ...requests,
      ...candidates.map(({ id, reason }) => ({ id, reason, requestedAt })),
    ].sort((left, right) => left.id.localeCompare(right.id)),
  };
}
