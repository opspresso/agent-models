/**
 * Adding a route, and what adding one does to the family.
 *
 * A family whose only routes are routers carries the router's numbers — the
 * discounted rate, with the discount beside it — because that is what the
 * model costs through the one door it has. The day a vendor route is added,
 * the family becomes the vendor's model: its price is the *list* price, and
 * the router's discount moves to the router's offering as an override (the
 * OpenRouter apply step does that the same run). `promoteFamily` is that
 * step, written once.
 *
 * A route is never added to a family every route of which is hidden: that
 * family was retired on purpose, and a catalog listing it again is not a
 * reason to resurrect it.
 */

import type { ModelPricing, PlacedOffering, Registry } from "../registry.ts";
import type { Change } from "./types.ts";

export const ROUTER_PROVIDERS = new Set(["bedrock", "openrouter"]);

/** Whether the family has at least one route that is not hidden. */
export function familyIsLive(registry: Registry, family: string): boolean {
  return registry.offerings.some((o) => o.family === family && !o.hidden);
}

export function familyHasRoute(registry: Registry, family: string, provider: string): boolean {
  return registry.offerings.some((o) => o.family === family && o.provider === provider);
}

export function familyIsRouterOnly(registry: Registry, family: string): boolean {
  const routes = registry.offerings.filter((o) => o.family === family);
  return routes.length > 0 && routes.every((o) => ROUTER_PROVIDERS.has(o.provider));
}

/** The rate before a promotional discount: `rate / (1 - discount)`, trimmed of float noise. */
export function undiscounted(pricing: ModelPricing): ModelPricing {
  const d = pricing.discount;
  if (d === undefined || !(d > 0 && d < 1)) {
    const { discount: _discount, ...rest } = pricing;
    return rest;
  }
  const up = (v: number | undefined) => (v === undefined ? undefined : Number((v / (1 - d)).toFixed(8)));
  const { discount: _discount, ...rest } = pricing;
  return {
    ...rest,
    inputPer1M: up(rest.inputPer1M) as number,
    outputPer1M: up(rest.outputPer1M) as number,
    ...(rest.cachedInputPer1M !== undefined ? { cachedInputPer1M: up(rest.cachedInputPer1M) as number } : {}),
    ...(rest.perSearch !== undefined ? { perSearch: up(rest.perSearch) as number } : {}),
    ...(rest.perAudioMinute !== undefined ? { perAudioMinute: up(rest.perAudioMinute) as number } : {}),
  };
}

/**
 * Make a router-only family the vendor's model, ahead of its first vendor
 * route: list price, no discount on the family. Mutates the registry it is
 * given (callers work on a clone).
 */
export function promoteFamily(registry: Registry, familyId: string, changes: Change[]): void {
  const family = registry.families[familyId];
  if (family === undefined || !familyIsRouterOnly(registry, familyId) || family.pricing.discount === undefined) {
    return;
  }
  const listed = undiscounted(family.pricing);
  changes.push({ target: `family ${familyId}`, field: "pricing", from: family.pricing, to: listed });
  family.pricing = listed;
}

/**
 * Add a route a catalog says exists. The family is promoted first when this
 * is its first vendor route. An addition is a change, not a note: it is
 * announced with the other changes, and needs nobody's follow-up. Answers
 * whether anything was added.
 */
export function addRoute(registry: Registry, offering: PlacedOffering, changes: Change[]): boolean {
  const { family, provider } = offering;
  if (registry.families[family] === undefined || familyHasRoute(registry, family, provider)) {
    return false;
  }
  if (!familyIsLive(registry, family)) {
    return false;
  }
  if (!ROUTER_PROVIDERS.has(provider)) {
    promoteFamily(registry, family, changes);
  }
  registry.offerings.push(offering);
  changes.push({ target: `offering ${provider}/${family}`, field: "added", from: undefined, to: offering.wireId ?? family });
  return true;
}
