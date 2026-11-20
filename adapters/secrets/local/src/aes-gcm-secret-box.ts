import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  type SealedSecret,
  type SecretContext,
  SecretOpenError,
  type SecretOpener,
  type SecretSealer,
} from "@aep/application";

// AES-256-GCM under the instance master key (ADR-013, ADR-007). A sealed secret is
// `v1.<key id>.<iv>.<ciphertext and tag>`, base64url. The key id lets a wrong key be reported as
// such instead of as a corrupt ciphertext, and leaves room to rotate keys later. The context is
// the additional authenticated data: it is not stored, so the caller must supply the same one.

export const MASTER_KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const VERSION = "v1";

/**
 * Reads the master key: 32 random bytes, base64 encoded, e.g. `openssl rand -base64 32 > key`.
 * Throws when the file is missing or holds anything else, so a process never starts with no key
 * or a weak one.
 */
export function loadMasterKey(path: string): Buffer {
  let text: string;
  try {
    text = readFileSync(path, "utf8").trim();
  } catch (error) {
    throw new Error(`master key file ${path} cannot be read`, { cause: error });
  }
  const key = Buffer.from(text, "base64");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text) || key.length !== MASTER_KEY_BYTES) {
    throw new Error(
      `master key file ${path} must hold ${String(MASTER_KEY_BYTES)} bytes in base64 (openssl rand -base64 32)`,
    );
  }
  return key;
}

const keyId = (key: Buffer): string =>
  createHash("sha256").update("aep-master-key-id\0").update(key).digest("hex").slice(0, 16);

export function aesGcmSecretBox(key: Buffer): SecretSealer & SecretOpener {
  if (key.length !== MASTER_KEY_BYTES) {
    throw new Error(`master key must be ${String(MASTER_KEY_BYTES)} bytes`);
  }
  const id = keyId(key);
  return {
    seal(plaintext: string, context: SecretContext): SealedSecret {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(context, "utf8"));
      const body = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
      return [VERSION, id, iv.toString("base64url"), body.toString("base64url")].join(
        ".",
      ) as SealedSecret;
    },

    open(sealed: SealedSecret, context: SecretContext): string {
      const parts = sealed.split(".");
      if (parts.length !== 4 || parts[0] !== VERSION) throw new SecretOpenError("unknown format");
      const [, sealedKeyId = "", ivText = "", bodyText = ""] = parts;
      if (sealedKeyId !== id) throw new SecretOpenError("sealed under another master key");
      const iv = Buffer.from(ivText, "base64url");
      const body = Buffer.from(bodyText, "base64url");
      if (iv.length !== IV_BYTES || body.length < TAG_BYTES) {
        throw new SecretOpenError("truncated");
      }
      const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
      decipher.setAAD(Buffer.from(context, "utf8"));
      decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
      try {
        return Buffer.concat([
          decipher.update(body.subarray(0, body.length - TAG_BYTES)),
          decipher.final(),
        ]).toString("utf8");
      } catch {
        // Never say which: a changed ciphertext and a different context look the same.
        throw new SecretOpenError("authentication failed");
      }
    },
  };
}
