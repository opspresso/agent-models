import assert from "node:assert/strict";
import { it } from "node:test";
import { createSecretCipher } from "../src/infrastructure/crypto/secret-cipher.ts";

it("authenticates ciphertext against its provider and detects tampering or a wrong key", () => {
  const cipher = createSecretCipher(Buffer.alloc(32, 7).toString("base64"));
  const encrypted = cipher.encrypt("fixture-secret", "provider-one");
  assert.equal(cipher.decrypt(encrypted, "provider-one"), "fixture-secret");
  assert.ok(!encrypted.includes("fixture-secret"));
  assert.throws(() => cipher.decrypt(encrypted, "provider-two"), /could not be decrypted/);
  assert.throws(() => createSecretCipher(Buffer.alloc(32, 8).toString("base64")).decrypt(encrypted, "provider-one"));
  const altered = Buffer.from(encrypted.slice(3), "base64");
  altered[altered.length - 1] = altered.at(-1)! ^ 1;
  assert.throws(() => cipher.decrypt(`v1:${altered.toString("base64")}`, "provider-one"));
  assert.throws(() => createSecretCipher("not-a-key"), /32-byte key/);
});
