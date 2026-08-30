import { createHash } from "node:crypto";
import type { Registry } from "./registry.ts";

export function anomalyDigest(anomalies: readonly string[]): string {
  return createHash("sha256").update([...anomalies].sort().join("\n")).digest("hex").slice(0, 12);
}

/** Quarantine destructive bulk changes while allowing valid provider metadata updates. */
export function detectRegistryAnomalies(before: Registry, after: Registry): string[] {
  const anomalies: string[] = [];
  const beforeFamilies = new Set(Object.keys(before.families));
  const afterFamilies = new Set(Object.keys(after.families));
  const removedFamilies = [...beforeFamilies].filter((id) => !afterFamilies.has(id));
  if (removedFamilies.length > 0) anomalies.push(`${removedFamilies.length} families would be removed`);

  const offeringId = (offering: Registry["offerings"][number]): string => `${offering.provider}/${offering.family}`;
  const beforeOfferings = new Set(before.offerings.map(offeringId));
  const afterOfferings = new Set(after.offerings.map(offeringId));
  const removedOfferings = [...beforeOfferings].filter((id) => !afterOfferings.has(id));
  if (removedOfferings.length > 0) anomalies.push(`${removedOfferings.length} offerings would be removed`);

  for (const provider of before.providers) {
    const previous = before.offerings.filter((offering) => offering.provider === provider && !offering.hidden);
    const oldById = new Map(previous.map((offering) => [offeringId(offering), offering]));
    const newlyMissing = after.offerings.filter((offering) => {
      const old = oldById.get(offeringId(offering));
      return offering.provider === provider && old !== undefined && old.missingSince === undefined && offering.missingSince !== undefined;
    }).length;
    if (newlyMissing >= 3 && newlyMissing / previous.length >= 0.5) {
      anomalies.push(`${provider}: ${newlyMissing} of ${previous.length} live offerings became missing at once`);
    }
  }

  const beforeById = new Map(before.offerings.map((offering) => [offeringId(offering), offering]));
  const newlyHidden = after.offerings.filter((offering) => {
    const old = beforeById.get(offeringId(offering));
    return old !== undefined && !old.hidden && offering.hidden && !["reset", "ranking"].includes(offering.hiddenReason ?? "");
  }).length;
  if (newlyHidden >= 10) anomalies.push(`${newlyHidden} offerings would become hidden at once`);
  return anomalies;
}
