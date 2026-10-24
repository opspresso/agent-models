import type { Pool } from "pg";
import type { createAuth, AuthConfiguration } from "./create-auth.ts";
import type { createStudioAccess } from "./studio-access.ts";
import { RouterError } from "../../domain/router/errors.ts";

/** A separate lock pool prevents refresh waiters from exhausting the auth adapter's connections. */
export function createSessionAccess(auth: ReturnType<typeof createAuth>, studio: ReturnType<typeof createStudioAccess>, locks: Pool, config: AuthConfiguration) {
  return async (headers: Headers) => {
    const session = await auth.api.getSession({ headers });
    if (!session) return null;
    const context = await auth.$context;
    const account = (await context.internalAdapter.findAccounts(session.user.id)).find(value => value.providerId === config.providerId);
    if (!account || (account as { issuer?: string }).issuer !== config.issuer) throw new RouterError("unauthorized", 401, "Studio account binding is unavailable");
    const getToken = () => auth.api.getAccessToken({ headers, body: { accountId: account.id } });
    let token: Awaited<ReturnType<typeof getToken>>;
    if (account.accessTokenExpiresAt && new Date(account.accessTokenExpiresAt).getTime() > Date.now() + 10_000) {
      token = await getToken();
    } else {
      const lock = await locks.connect();
      try {
        await lock.query("BEGIN");
        await lock.query("SET LOCAL lock_timeout='5s'");
        await lock.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`agent_models_oidc:${account.id}`]);
        // The auth API rereads the account after the lock, seeing a prior refresher's committed token.
        token = await getToken();
        await lock.query("COMMIT");
      } catch (error) { await lock.query("ROLLBACK"); throw error; }
      finally { lock.release(); }
    }
    const principal = await studio.bearer(token.accessToken);
    if (principal.kind !== "user" || principal.subject !== account.accountId || principal.clientId !== config.clientId || principal.service !== "agent-models") {
      throw new RouterError("unauthorized", 401, "Studio credential does not match this browser account");
    }
    return principal;
  };
}
