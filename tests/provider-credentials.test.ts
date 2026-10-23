import assert from "node:assert/strict";
import { it } from "node:test";
import { createManagement } from "../src/application/management.ts";
import type { RouterRepository } from "../src/domain/router/repository.ts";
import type { Principal, StoredProvider } from "../src/domain/router/types.ts";
import { providerCredentialContext } from "../src/domain/router/validation.ts";
import { createSecretCipher } from "../src/infrastructure/crypto/secret-cipher.ts";

const admin: Principal = { subject: "operator", kind: "user", service: "agent-models", admin: true, canInvoke: true };
const configuration = { id: "provider", name: "Fixture", kind: "selfhosted" as const, auth: "secret" as const, enabled: true, baseUrl: "https://provider.example.test/v1" };
function fixture() {
  const cipher = createSecretCipher(Buffer.alloc(32, 7).toString("base64"));
  let stored: StoredProvider | null = null;
  const discovered: string[] = [];
  const repository = {
    getProvider: async () => stored,
    saveProvider: async (value: Omit<StoredProvider, "revision" | "updatedAt">) => {
      stored = { ...value, revision: (stored?.revision ?? 0) + 1, updatedAt: new Date().toISOString() }; return stored;
    },
    replaceDiscovered: async () => {},
  } as unknown as RouterRepository;
  const management = createManagement(repository, cipher, { discover: async (_provider, secret) => { discovered.push(secret!); return []; } });
  return { management, cipher, discovered, read: () => stored!, tamper: (change: Partial<StoredProvider>) => { stored = { ...stored!, ...change }; } };
}

it("preserves a key for canonical-equivalent URLs and display changes, without exposing it to discovery callers", async () => {
  const f = fixture(); await f.management.saveProvider(admin, { ...configuration, secret: "fixture-secret" }, null);
  const ciphertext = f.read().encryptedSecret;
  await f.management.saveProvider(admin, { ...configuration, baseUrl: "https://PROVIDER.example.test:443/v1/", name: "Renamed", secret: " •••• " }, 1);
  assert.equal(f.read().encryptedSecret, ciphertext);
  assert.equal(f.read().baseUrl, configuration.baseUrl);
  assert.deepEqual(await f.management.discover(admin, configuration.id), { discovered: 0 });
  assert.deepEqual(f.discovered, ["fixture-secret"]);
});

it("requires a newly supplied key for changed recipients or protocols and binds replacement ciphertext to that destination", async () => {
  const f = fixture(); await f.management.saveProvider(admin, { ...configuration, secret: "fixture-secret" }, null);
  const original = f.read();
  for (const change of [{ baseUrl: "https://other.example.test/v1" }, { baseUrl: "https://provider.example.test/v2" }, { kind: "anthropic" as const }]) {
    for (const secret of [undefined, "", "********"]) {
      await assert.rejects(f.management.saveProvider(admin, { ...configuration, ...change, ...(secret === undefined ? {} : { secret }) }, 1), { code: "credential_required" });
      assert.deepEqual(f.read(), original);
    }
  }
  const changed = { ...configuration, baseUrl: "https://other.example.test/v1" };
  await f.management.saveProvider(admin, { ...changed, secret: "replacement-secret" }, 1);
  assert.equal(f.cipher.decrypt(f.read().encryptedSecret!, providerCredentialContext(changed)), "replacement-secret");
  assert.throws(() => f.cipher.decrypt(f.read().encryptedSecret!, providerCredentialContext(configuration)), /could not be decrypted/);
});

it("refuses to decrypt after stored recipient, protocol or authentication tampering, before contacting discovery", async () => {
  const f = fixture(); await f.management.saveProvider(admin, { ...configuration, secret: "fixture-secret" }, null);
  const original = f.read();
  for (const change of [{ baseUrl: "https://other.example.test/v1" }, { kind: "anthropic" as const }, { auth: "none" as const }]) {
    f.tamper({ ...original, ...change });
    await assert.rejects(f.management.discover(admin, configuration.id), /could not be decrypted/);
  }
  assert.deepEqual(f.discovered, []);
});
