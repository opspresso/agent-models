import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { createManagement } from "../application/management.ts";
import { createInference } from "../application/inference.ts";
import { initializeSchema } from "../infrastructure/database/schema.ts";
import { createRouterRepository } from "../infrastructure/database/router-repository.ts";
import { createSecretCipher } from "../infrastructure/crypto/secret-cipher.ts";
import { createModelDiscovery } from "../infrastructure/providers/discovery.ts";
import { createProviderTransport } from "../infrastructure/providers/transport.ts";
import { createAuth } from "../infrastructure/auth/create-auth.ts";
import { createStudioAccess } from "../infrastructure/auth/studio-access.ts";
import { createSessionAccess } from "../infrastructure/auth/session-access.ts";
import { readConfiguration } from "./config.ts";
import { publishedCatalog } from "./catalog.ts";
import { RouterError } from "../domain/router/errors.ts";
import { createBedrockSigner } from "../infrastructure/providers/bedrock-signer.ts";

async function initialize() {
  const config = readConfiguration();
  const cipher = createSecretCipher(config.encryptionKey);
  const pool = new Pool({ connectionString: config.databaseUrl, max: 16, connectionTimeoutMillis: 5000 });
  const locks = new Pool({ connectionString: config.databaseUrl, max: 4, connectionTimeoutMillis: 5000 });
  pool.on("error", () => console.error(JSON.stringify({ event: "models_database_connection_error" })));
  locks.on("error", () => console.error(JSON.stringify({ event: "models_auth_lock_connection_error" })));
  try {
    await initializeSchema(pool);
    const repository = createRouterRepository(pool);
    const auth = createAuth(pool, config);
    const context = await auth.$context;
    if (!context.socialProviders.some(provider => provider.id === config.providerId)) throw new RouterError("identity_unavailable", 503, "Studio OIDC discovery could not be verified");
    const studio = createStudioAccess(config);
    const signer = createBedrockSigner();
    let sweeping = false;
    const maintenance = setInterval(async () => {
      if (sweeping) return;
      sweeping = true;
      try { await repository.expire(); }
      catch { console.error(JSON.stringify({ event: "models_request_expiry_failed" })); }
      finally { sweeping = false; }
    }, 30_000);
    maintenance.unref();
    return { config, pool, repository, auth, studio, session: createSessionAccess(auth, studio, locks, config),
      management: createManagement(repository, cipher, createModelDiscovery({ catalog: publishedCatalog, signer })),
      inference: createInference({ repository, cipher, transport: createProviderTransport({ signer }), executionId: randomUUID, now: Date.now,
        monotonic: () => performance.now(), timeoutMs: config.inferenceTimeoutMs, concurrencyLimit: config.maxConcurrent }),
      async close() { clearInterval(maintenance); await Promise.all([pool.end(), locks.end()]); },
    };
  } catch (error) { await Promise.all([pool.end(), locks.end()]); throw error; }
}

export type Runtime = Awaited<ReturnType<typeof initialize>>;
const SLOT = Symbol.for("opspresso.agent-models.runtime");
const scope = globalThis as typeof globalThis & { [SLOT]?: { promise: Promise<Runtime>; retryAt?: number } };
/** A failed pre-admission bootstrap can recover on the next request without replaying inference. */
export function runtime(): Promise<Runtime> {
  const current = scope[SLOT];
  if (current && (current.retryAt === undefined || current.retryAt > Date.now())) return current.promise;
  const state: { promise: Promise<Runtime>; retryAt?: number } = { promise: initialize() };
  state.promise = state.promise.catch(error => { state.retryAt = Date.now() + 5000; throw error; });
  scope[SLOT] = state;
  return state.promise;
}
