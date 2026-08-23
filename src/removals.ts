import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface RemovalApproval {
  id: string;
  reason: string;
  approvedAt: string;
}

function isUtcDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

export function loadRemovalManifest(root: string): RemovalApproval[] {
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
    const unknown = Object.keys(row).filter((key) => !["id", "reason", "approvedAt"].includes(key));
    if (unknown.length > 0) throw new Error(`models/removals.json[${index}] has unknown field "${unknown[0]}"`);
    if (typeof row.id !== "string" || !/^[a-z0-9._-]+\/[a-z0-9._-]+$/.test(row.id)) {
      throw new Error(`models/removals.json[${index}].id must be provider/family`);
    }
    if (seen.has(row.id)) throw new Error(`models/removals.json repeats "${row.id}"`);
    seen.add(row.id);
    if (typeof row.reason !== "string" || row.reason.trim() === "") {
      throw new Error(`models/removals.json[${index}].reason is required`);
    }
    if (!isUtcDate(row.approvedAt)) {
      throw new Error(`models/removals.json[${index}].approvedAt must be a valid UTC date`);
    }
  }
  return value as RemovalApproval[];
}

export function unapprovedRemovals(
  previousIds: readonly string[],
  nextIds: readonly string[],
  approvals: readonly RemovalApproval[],
): string[] {
  const next = new Set(nextIds);
  const approved = new Set(approvals.map(({ id }) => id));
  return previousIds.filter((id) => !next.has(id) && !approved.has(id));
}

export function assertRemovalPolicy(
  previousIds: readonly string[],
  nextIds: readonly string[],
  approvals: readonly RemovalApproval[],
  pullRequest: boolean,
): void {
  const next = new Set(nextIds);
  const removed = previousIds.filter((id) => !next.has(id));
  if (removed.length === 0) return;
  if (!pullRequest) {
    throw new Error(`published model removals are allowed only through a pull request: ${removed.join(", ")}`);
  }
  const unapproved = unapprovedRemovals(previousIds, nextIds, approvals);
  if (unapproved.length > 0) {
    throw new Error(
      `unapproved published model removal(s): ${unapproved.join(", ")} — add exact entries to models/removals.json`,
    );
  }
}
