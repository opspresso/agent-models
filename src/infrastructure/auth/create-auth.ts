import { betterAuth } from "better-auth";
import { genericOAuth } from "better-auth/plugins";
import { nextCookies } from "better-auth/next-js";
import { APIError } from "better-auth/api";
import type { Pool } from "pg";
import { MODELS_RESOURCE, PLATFORM_IDENTITY_CLAIM, platformIdentity } from "../../domain/identity.ts";

export interface AuthConfiguration {
  authBaseUrl: string; authSecret: string; issuer: string; clientId: string; clientSecret: string; providerId: string; scopes: string[];
}

/** Studio is the sole identity authority; local accounts retain only the RP session binding. */
export function createAuth(pool: Pool, config: AuthConfiguration) {
  return betterAuth({
    baseURL: config.authBaseUrl, secret: config.authSecret, database: pool,
    logger: { log: level => { if (level === "error" || level === "warn") console.error(JSON.stringify({ event: "models_auth", level })); } },
    user: { modelName: "agent_models_user" }, session: { modelName: "agent_models_session" },
    account: { modelName: "agent_models_account", accountLinking: { disableImplicitLinking: true }, encryptOAuthTokens: true,
      additionalFields: { issuer: { type: "string", input: false, required: false } } },
    verification: { modelName: "agent_models_verification" },
    disabledPaths: ["/get-access-token", "/refresh-token"],
    advanced: { cookiePrefix: "agent-models", trustedProxyHeaders: false },
    onAPIError: { errorURL: "/login" },
    databaseHooks: { account: { create: { before: async account => ({ data: { ...account, issuer: config.issuer } }) } } },
    plugins: [genericOAuth({ config: [{
      providerId: config.providerId, name: "Agent Studio", clientId: config.clientId, clientSecret: config.clientSecret,
      discoveryUrl: `${config.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`, scopes: config.scopes,
      pkce: true, requireIdTokenVerification: true, overrideUserInfo: true, disableProviderLogout: true,
      authorizationUrlParams: { resource: MODELS_RESOURCE },
      accountSubject({ tokens, profile }) {
        if (!tokens.idToken) throw new APIError("FORBIDDEN", { message: "Verified Studio ID token is required" });
        let claims: Record<string, unknown>;
        try { claims = JSON.parse(Buffer.from(tokens.idToken.split(".")[1] ?? "", "base64url").toString()); }
        catch { throw new APIError("FORBIDDEN", { message: "Invalid Studio identity" }); }
        if (claims.iss !== config.issuer || typeof claims.sub !== "string" || claims.sub !== profile.sub) throw new APIError("FORBIDDEN", { message: "Studio identity does not match UserInfo" });
        return claims.sub;
      },
      async mapProfileToUser(profile) {
        if (typeof profile.sub !== "string" || typeof profile.email !== "string" || typeof profile.name !== "string") throw new APIError("FORBIDDEN", { message: "Studio profile is incomplete" });
        platformIdentity(profile[PLATFORM_IDENTITY_CLAIM], profile.sub);
        const stored = (await pool.query<{ issuer: string | null }>('SELECT issuer FROM agent_models_account WHERE "providerId"=$1 AND "accountId"=$2', [config.providerId, profile.sub])).rows[0];
        if (stored && stored.issuer !== config.issuer) throw new APIError("FORBIDDEN", { message: "Studio issuer does not match the existing account" });
        return { name: profile.name, email: profile.email, emailVerified: profile.email_verified === true,
          ...(typeof profile.picture === "string" ? { image: profile.picture } : {}) };
      },
    }] }), nextCookies()],
  });
}
