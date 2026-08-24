import { createHash } from "node:crypto";
import { deriveModels, type Registry } from "./registry.ts";

const PRICE_RATIO_LIMIT = 10;
const LIMIT_RATIO_LIMIT = 4;
const FAMILY_ADDITION_LIMIT = 20;
const OFFERING_ADDITION_LIMIT = 40;

export function anomalyDigest(anomalies: readonly string[]): string {
  return createHash("sha256").update([...anomalies].sort().join("\n")).digest("hex").slice(0, 12);
}

function ratio(left: number, right: number): number {
  if (left === right) return 1;
  if (left === 0 || right === 0) return Number.POSITIVE_INFINITY;
  return Math.max(left, right) / Math.min(left, right);
}

/** Conservative quarantine checks for a provider-wide shape or unit mistake. */
export function detectRegistryAnomalies(
  before: Registry,
  after: Registry,
  options: { allowPolicyBootstrap?: boolean } = {},
): string[] {
  const anomalies: string[] = [];
  const beforeFamilies = new Set(Object.keys(before.families));
  const afterFamilies = new Set(Object.keys(after.families));
  const removedFamilies = [...beforeFamilies].filter((id) => !afterFamilies.has(id));
  const addedFamilies = [...afterFamilies].filter((id) => !beforeFamilies.has(id));
  if (removedFamilies.length > 0) anomalies.push(`${removedFamilies.length} families would be removed`);
  if (!options.allowPolicyBootstrap && addedFamilies.length > FAMILY_ADDITION_LIMIT) anomalies.push(`${addedFamilies.length} families would be added`);

  const offeringId = (offering: Registry["offerings"][number]): string => `${offering.provider}/${offering.family}`;
  const beforeOfferings = new Set(before.offerings.map(offeringId));
  const afterOfferings = new Set(after.offerings.map(offeringId));
  const removedOfferings = [...beforeOfferings].filter((id) => !afterOfferings.has(id));
  const addedOfferings = [...afterOfferings].filter((id) => !beforeOfferings.has(id));
  if (removedOfferings.length > 0) anomalies.push(`${removedOfferings.length} offerings would be removed`);
  if (!options.allowPolicyBootstrap && addedOfferings.length > OFFERING_ADDITION_LIMIT) anomalies.push(`${addedOfferings.length} offerings would be added`);

  const oldModels = new Map(deriveModels(before).map((model) => [model.id, model]));
  for (const model of deriveModels(after)) {
    const old = oldModels.get(model.id);
    if (old === undefined) continue;
    for (const field of ["inputPer1M", "outputPer1M", "cachedInputPer1M", "imageInputPer1M", "imageOutputPer1M", "perImage", "perInputImage"] as const) {
      const from = old.pricing[field];
      const to = model.pricing[field];
      if (from !== undefined && to !== undefined && ratio(from, to) > PRICE_RATIO_LIMIT) {
        anomalies.push(`${model.id} pricing.${field} changed by more than ${PRICE_RATIO_LIMIT}x`);
      }
    }
    if (ratio(old.contextWindow, model.contextWindow) > LIMIT_RATIO_LIMIT) {
      anomalies.push(`${model.id} contextWindow changed by more than ${LIMIT_RATIO_LIMIT}x`);
    }
    if (ratio(old.maxTokens, model.maxTokens) > LIMIT_RATIO_LIMIT) {
      anomalies.push(`${model.id} maxTokens changed by more than ${LIMIT_RATIO_LIMIT}x`);
    }
  }

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
    return old !== undefined && !old.hidden && offering.hidden && offering.hiddenReason !== "reset";
  }).length;
  if (newlyHidden >= 10) anomalies.push(`${newlyHidden} offerings would become hidden at once`);
  return anomalies;
}
