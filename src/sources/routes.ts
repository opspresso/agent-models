/** Native routes use verified prices when available and otherwise follow OpenRouter. */

import type { ModelPricing, PlacedOffering, Registry } from "../registry.ts";
import { samePricing, type Change } from "./types.ts";

const ROUTER_PROVIDERS = new Set(["bedrock", "openrouter"]);

export function familyIsLive(registry: Registry, family: string): boolean {
  return registry.offerings.some((o) => o.family === family && !o.hidden);
}

export function familyHasRoute(registry: Registry, family: string, provider: string): boolean {
  return registry.offerings.some((o) => o.family === family && o.provider === provider);
}

/** Keep each gateway's last quote when the shared family price changes ownership. */
function preserveRouterPricing(registry: Registry, familyId: string, changes: Change[]): void {
  const family = registry.families[familyId]!;
  for (const offering of registry.offerings.filter((o) => o.family === familyId && ROUTER_PROVIDERS.has(o.provider))) {
    const previous = { ...family.pricing, ...offering.pricing };
    if (!samePricing(offering.pricing, previous)) {
      changes.push({ target: `offering ${offering.provider}/${familyId}`, field: "pricing", from: offering.pricing, to: previous });
      offering.pricing = previous;
    }
  }
}

/** Replace a fallback with an actual native quote without repricing gateway routes. */
export function setNativePricing(registry: Registry, familyId: string, pricing: ModelPricing, changes: Change[]): void {
  const family = registry.families[familyId]!;
  if (!samePricing({ ...family.pricing }, { ...pricing })) {
    preserveRouterPricing(registry, familyId, changes);
    changes.push({ target: `family ${familyId}`, field: "pricing", from: family.pricing, to: pricing });
    family.pricing = { ...pricing };
  }
  if (family.pricingSource !== "native") {
    changes.push({ target: `family ${familyId}`, field: "pricingSource", from: family.pricingSource, to: "native" });
    family.pricingSource = "native";
  }
}

/** Add a served route once, preserving manual retirement and the source of unverified prices. */
export function addRoute(
  registry: Registry,
  offering: PlacedOffering,
  changes: Change[],
  nativePricing?: ModelPricing,
): boolean {
  const { family: familyId, provider } = offering;
  const family = registry.families[familyId];
  if (family === undefined || familyHasRoute(registry, familyId, provider) || !familyIsLive(registry, familyId)) return false;
  const routes = registry.offerings.filter((o) => o.family === familyId);
  const router = routes.find((o) => o.provider === "openrouter");
  if (nativePricing !== undefined) {
    setNativePricing(registry, familyId, nativePricing, changes);
  } else if (!ROUTER_PROVIDERS.has(provider) && family.pricingSource === undefined
    && router !== undefined && routes.every((o) => ROUTER_PROVIDERS.has(o.provider))) {
    const fallback = { ...family.pricing, ...router.pricing };
    if (!samePricing({ ...family.pricing }, fallback)) {
      preserveRouterPricing(registry, familyId, changes);
      changes.push({ target: `family ${familyId}`, field: "pricing", from: family.pricing, to: fallback });
      family.pricing = fallback;
    }
    family.pricingSource = "openrouter";
    changes.push({ target: `family ${familyId}`, field: "pricingSource", from: undefined, to: "openrouter" });
  }
  registry.offerings.push(offering);
  changes.push({ target: `offering ${provider}/${familyId}`, field: "added", from: undefined, to: offering.wireId ?? familyId });
  return true;
}
