import { createRemoteJWKSet, jwtVerify, customFetch, errors } from "jose";
import { MODELS_RESOURCE, PLATFORM_IDENTITY_CLAIM, PLATFORM_SERVICE_CLAIM, platformIdentity, type AuthenticatedPrincipal } from "../../domain/identity.ts";
import { RouterError } from "../../domain/router/errors.ts";
import type { AuthConfiguration } from "./create-auth.ts";
import { readResponseBytes } from "../http/read-response.ts";

const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const SERVICES = new Set(["agent-studio", "agent-models", "agent-forge", "agent-librio", "agent-memory"]);

/** JWT validation plus introspection handles audience, signature, client revocation and session expiry. */
export function createStudioAccess(config: AuthConfiguration, request: typeof fetch = fetch) {
  let metadata: { userinfo: string; introspection: string; jwks: ReturnType<typeof createRemoteJWKSet> } | undefined;
  async function fetchJson(url: string, init: RequestInit) {
    let response: Response;
    try { response = await request(url, { ...init, redirect: "error", signal: AbortSignal.timeout(5000) }); }
    catch { throw new RouterError("identity_unavailable", 503, "Studio identity service is unavailable"); }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403) throw new RouterError("unauthorized", 401, "Studio credential is no longer valid");
      throw new RouterError("identity_unavailable", 503, "Studio identity service could not complete the request");
    }
    try { const body = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readResponseBytes(response, 64 * 1024)))); if (body) return body; }
    catch { /* The bounded response is rejected below. */ }
    throw new RouterError("identity_unavailable", 503, "Studio identity response is invalid");
  }
  async function discovery() {
    if (metadata) return metadata;
    const value = await fetchJson(`${config.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`, {});
    if (value.issuer !== config.issuer) throw new RouterError("identity_unavailable", 503, "Studio issuer does not match configuration");
    const endpoint = (name: string) => {
      if (typeof value[name] !== "string") throw new RouterError("identity_unavailable", 503, "Studio discovery is incomplete");
      const parsed = new URL(value[name]);
      if (parsed.origin !== new URL(config.issuer).origin || !parsed.pathname.startsWith(new URL(config.issuer).pathname + "/") || parsed.username || parsed.password || parsed.hash) {
        throw new RouterError("identity_unavailable", 503, "Studio discovery returned an unexpected endpoint");
      }
      return parsed.href;
    };
    const jwks = endpoint("jwks_uri");
    metadata = { userinfo: endpoint("userinfo_endpoint"), introspection: endpoint("introspection_endpoint"), jwks: createRemoteJWKSet(new URL(jwks), {
      [customFetch]: async (url, init) => {
        const response = await request(url, { ...init, redirect: "error" });
        if (!response.ok) { await response.body?.cancel(); return new Response(null, { status: response.status }); }
        return new Response(await readResponseBytes(response, 64 * 1024), { headers: { "content-type": "application/json" } });
      },
    }) };
    return metadata;
  }
  return {
    async userInfo(token: string, expectedSubject?: string): Promise<AuthenticatedPrincipal> {
      const urls = await discovery();
      const profile = await fetchJson(urls.userinfo, { headers: { authorization: `Bearer ${token}` } });
      if (typeof profile.sub !== "string" || (expectedSubject !== undefined && profile.sub !== expectedSubject)) throw new RouterError("unauthorized", 401, "Studio subject does not match this account");
      const identity = platformIdentity(profile[PLATFORM_IDENTITY_CLAIM], profile.sub);
      return { kind: "user", service: "agent-models", subject: profile.sub, admin: identity.admin, canInvoke: identity.canRunAgents, tier: identity.tier,
        scopes: [], ...(typeof profile.name === "string" ? { name: profile.name } : {}), ...(typeof profile.email === "string" ? { email: profile.email } : {}),
        image: typeof profile.picture === "string" ? profile.picture : null };
    },
    async bearer(token: string): Promise<AuthenticatedPrincipal> {
      if (!token || token.length > 16_384 || token.split(".").length !== 3) throw new RouterError("unauthorized", 401, "Invalid access token");
      const urls = await discovery();
      let claims;
      try { claims = (await jwtVerify(token, urls.jwks, { issuer: config.issuer, audience: MODELS_RESOURCE, algorithms: ["RS256"], typ: "at+jwt",
        requiredClaims: ["sub", "exp", "iat", "jti", "client_id", "azp", "scope"] })).payload; }
      catch (error) {
        const invalid = error instanceof errors.JOSEError && ["ERR_JWT_EXPIRED", "ERR_JWT_CLAIM_VALIDATION_FAILED", "ERR_JWS_SIGNATURE_VERIFICATION_FAILED", "ERR_JWS_INVALID", "ERR_JWT_INVALID", "ERR_JOSE_ALG_NOT_ALLOWED", "ERR_JWKS_NO_MATCHING_KEY"].includes(error.code);
        throw new RouterError(invalid ? "unauthorized" : "identity_unavailable", invalid ? 401 : 503, invalid ? "Invalid access token" : "Studio signing keys are unavailable");
      }
      const checked = await fetchJson(urls.introspection, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, token }) });
      if (checked.active !== true || checked.sub !== claims.sub || typeof claims.sub !== "string" || typeof claims.client_id !== "string" || typeof checked.scope !== "string" || typeof claims.scope !== "string" || checked.client_id !== claims.client_id) throw new RouterError("unauthorized", 401, "Access token is no longer active");
      const service = object(claims[PLATFORM_SERVICE_CLAIM]);
      if (!service || typeof service.id !== "string" || !SERVICES.has(service.id) || (service.principal !== "user" && service.principal !== "service")) throw new RouterError("unauthorized", 401, "Access token does not identify a platform service");
      const signedScopes = new Set(claims.scope.split(" "));
      const scopes = checked.scope.split(" ").filter(scope => signedScopes.has(scope));
      if (service.principal === "service") {
        if (claims[PLATFORM_IDENTITY_CLAIM] !== undefined || claims.sub !== claims.client_id) throw new RouterError("unauthorized", 401, "Service credential cannot select a user");
        return { kind: "service", subject: `service:${service.id}`, service: service.id, admin: false, canInvoke: scopes.includes("models:invoke"), scopes, clientId: claims.client_id };
      }
      const user = await this.userInfo(token, claims.sub);
      return { ...user, service: service.id, scopes, clientId: claims.client_id };
    },
  };
}
