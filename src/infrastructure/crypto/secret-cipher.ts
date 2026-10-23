import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { SecretCipher } from "../../domain/router/repository.ts";

/** Provider-bound authenticated encryption prevents credentials being moved between connections. */
export function createSecretCipher(base64Key: string): SecretCipher {
  const key = Buffer.from(base64Key, "base64");
  if (key.length !== 32 || key.toString("base64") !== base64Key) throw new Error("AES_ENCRYPTION_KEY must be a canonical base64-encoded 32-byte key");
  return {
    encrypt(secret, providerId) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(providerId));
      const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
      return `v1:${Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64")}`;
    },
    decrypt(value, providerId) {
      try {
        if (!value.startsWith("v1:")) throw new Error("Invalid version");
        const bytes = Buffer.from(value.slice(3), "base64");
        if (bytes.length < 29 || bytes.toString("base64") !== value.slice(3)) throw new Error("Invalid ciphertext");
        const cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
        cipher.setAAD(Buffer.from(providerId));
        cipher.setAuthTag(bytes.subarray(12, 28));
        return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString("utf8");
      } catch {
        throw new Error("Provider credential could not be decrypted");
      }
    },
  };
}
