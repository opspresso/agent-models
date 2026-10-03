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
  const removedFamilies = [...beforeFamilies].filter((id) => !afterFamilies.has(id)).sort();
  if (removedFamilies.length > 0) anomalies.push(`${removedFamilies.length} families would be removed: ${removedFamilies.join(", ")}`);

  const offeringId = (offering: Registry["offerings"][number]): string => `${offering.provider}/${offering.family}`;
  const beforeOfferings = new Set(before.offerings.map(offeringId));
  const afterOfferings = new Set(after.offerings.map(offeringId));
  const removedOfferings = [...beforeOfferings].filter((id) => !afterOfferings.has(id)).sort();
  if (removedOfferings.length > 0) anomalies.push(`${removedOfferings.length} offerings would be removed: ${removedOfferings.join(", ")}`);

  for (const provider of before.providers) {
    const previous = before.offerings.filter((offering) => offering.provider === provider && !offering.hidden);
    const oldById = new Map(previous.map((offering) => [offeringId(offering), offering]));
    const newlyMissing = after.offerings.filter((offering) => {
      const old = oldById.get(offeringId(offering));
      return offering.provider === provider && old !== undefined && old.missingSince === undefined && offering.missingSince !== undefined;
    });
    if (newlyMissing.length >= 3 && newlyMissing.length / previous.length >= 0.5) {
      const changes = newlyMissing.map((offering) => JSON.stringify({
        id: offeringId(offering),
        missingSince: offering.missingSince,
        missingObservations: offering.missingObservations,
        lastMissingAt: offering.lastMissingAt,
      })).sort();
      anomalies.push(`${provider}: ${newlyMissing.length} of ${previous.length} live offerings became missing at once: ${changes.join(", ")}`);
    }
  }

  const beforeById = new Map(before.offerings.map((offering) => [offeringId(offering), offering]));
  const newlyHidden = after.offerings.filter((offering) => {
    const old = beforeById.get(offeringId(offering));
    return old !== undefined && !old.hidden && offering.hidden && !["reset", "ranking"].includes(offering.hiddenReason ?? "");
  });
  if (newlyHidden.length >= 10) {
    const changes = newlyHidden.map((offering) => JSON.stringify({
      id: offeringId(offering),
      hiddenReason: offering.hiddenReason,
      hiddenAt: offering.hiddenAt,
    })).sort();
    anomalies.push(`${newlyHidden.length} offerings would become hidden at once: ${changes.join(", ")}`);
  }
  return anomalies;
}
