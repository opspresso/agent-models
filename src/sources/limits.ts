import type { Registry } from "../registry.ts";
import type { Change } from "./types.ts";

/** Apply individually valid catalog counts only when the resulting family and routes remain consistent. */
export function applyFamilyLimits(
  registry: Registry,
  familyId: string,
  limits: { contextWindow: number | null; maxTokens: number | null },
  source: string,
  changes: Change[],
  notes: string[],
): void {
  const family = registry.families[familyId]!;
  const contextWindow = limits.contextWindow ?? family.contextWindow;
  const maxTokens = limits.maxTokens ?? family.maxTokens;
  const incompatibleRoute = registry.offerings.find(
    (offering) => offering.family === familyId && (offering.maxTokens ?? maxTokens) > contextWindow,
  );
  if (maxTokens > contextWindow || incompatibleRoute !== undefined) {
    const cap = incompatibleRoute?.maxTokens ?? maxTokens;
    const target = incompatibleRoute === undefined ? familyId : `${incompatibleRoute.provider}/${familyId}`;
    notes.push(`${source}/${familyId}: proposed window ${contextWindow} is below ${target}'s output cap ${cap}; limits left unchanged`);
    return;
  }
  for (const [field, value] of [["contextWindow", contextWindow], ["maxTokens", maxTokens]] as const) {
    if (value !== family[field]) {
      changes.push({ target: `family ${familyId}`, field, from: family[field], to: value });
      family[field] = value;
    }
  }
}
