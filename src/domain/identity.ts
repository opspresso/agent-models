import { RouterError } from "./router/errors.ts";
import type { Principal } from "./router/types.ts";

export const MODELS_RESOURCE = "urn:opspresso:agent:models";
export const PLATFORM_IDENTITY_CLAIM = "urn:opspresso:agent:identity";
export const PLATFORM_SERVICE_CLAIM = "urn:opspresso:agent:service";
export const MODEL_SCOPES = ["models:read", "models:invoke", "models:manage", "usage:read"] as const;
export type ModelScope = typeof MODEL_SCOPES[number];
export const SIGN_IN_SCOPES = ["openid", "email", "profile", "offline_access", "platform:identity", ...MODEL_SCOPES];

export interface PlatformIdentity {
  version: 1;
  userId: string;
  tier: string;
  admin: boolean;
  canRunAgents: boolean;
}
export interface AuthenticatedPrincipal extends Principal {
  scopes: string[];
  clientId?: string;
  name?: string;
  email?: string;
  image?: string | null;
  tier?: string;
}

export function mayManage(principal: AuthenticatedPrincipal): boolean { return principal.admin && principal.scopes.includes("models:manage"); }

export function platformIdentity(value: unknown, subject: string): PlatformIdentity {
  if (!value || typeof value !== "object") throw new RouterError("invalid_identity", 401, "Studio identity claims are missing");
  const identity = value as Record<string, unknown>;
  if (identity.version !== 1 || identity.userId !== subject || typeof identity.tier !== "string" || !/^[a-z][a-z0-9_-]{0,39}$/.test(identity.tier) ||
      typeof identity.admin !== "boolean" || typeof identity.canRunAgents !== "boolean" || (identity.admin && !identity.canRunAgents)) {
    throw new RouterError("invalid_identity", 401, "Studio identity claims are invalid");
  }
  return { version: 1, userId: subject, tier: identity.tier, admin: identity.admin, canRunAgents: identity.canRunAgents };
}

export function requireScope(principal: AuthenticatedPrincipal, scope: ModelScope): void {
  if (!principal.scopes.includes(scope)) throw new RouterError("insufficient_scope", 403, "The credential does not grant this operation");
}
