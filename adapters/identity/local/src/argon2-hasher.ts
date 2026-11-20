import { argon2, randomBytes, timingSafeEqual, type Argon2Parameters } from "node:crypto";
import type { PasswordHasher } from "@aep/application";

// Argon2id from node:crypto (Node >= 24.7), stored in the PHC string format
// `$argon2id$v=19$m=<KiB>,t=<passes>,p=<lanes>$<salt>$<tag>` (unpadded base64), so the parameters
// travel with each hash and can be raised later without breaking existing ones.

export type Argon2Settings = {
  /** KiB. */
  readonly memory: number;
  readonly passes: number;
  readonly parallelism: number;
};

/** OWASP Password Storage Cheat Sheet, checked 2026-11-14 (ADR-011). */
export const OWASP_ARGON2ID: Argon2Settings = { memory: 19_456, passes: 2, parallelism: 1 };

const SALT_BYTES = 16;
const TAG_BYTES = 32;
const PHC =
  /^\$argon2id\$v=19\$m=(\d{1,7}),t=(\d{1,2}),p=(\d{1,2})\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;
/** Refuse stored parameters that would make one verification unreasonably expensive. */
const MAX_MEMORY_KIB = 1_048_576;

const derive = (password: string, nonce: Buffer, settings: Argon2Settings, tagLength: number) =>
  new Promise<Buffer>((resolve, reject) => {
    const parameters: Argon2Parameters = {
      message: password,
      nonce,
      parallelism: settings.parallelism,
      tagLength,
      memory: settings.memory,
      passes: settings.passes,
    };
    argon2("argon2id", parameters, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });

const b64 = (bytes: Buffer): string => bytes.toString("base64").replace(/=+$/, "");

export class Argon2PasswordHasher implements PasswordHasher {
  readonly #settings: Argon2Settings;

  constructor(settings: Argon2Settings = OWASP_ARGON2ID) {
    this.#settings = settings;
  }

  async hash(password: string): Promise<string> {
    const salt = randomBytes(SALT_BYTES);
    const tag = await derive(password, salt, this.#settings, TAG_BYTES);
    const { memory, passes, parallelism } = this.#settings;
    return `$argon2id$v=19$m=${String(memory)},t=${String(passes)},p=${String(parallelism)}$${b64(salt)}$${b64(tag)}`;
  }

  async verify(hash: string, password: string): Promise<boolean> {
    const match = PHC.exec(hash);
    if (!match) return false;
    const [m = "", t = "", p = "", saltText = "", tagText = ""] = match.slice(1);
    const settings = { memory: Number(m), passes: Number(t), parallelism: Number(p) };
    if (settings.memory > MAX_MEMORY_KIB || settings.passes < 1 || settings.parallelism < 1) {
      return false;
    }
    const salt = Buffer.from(saltText, "base64");
    const expected = Buffer.from(tagText, "base64");
    if (salt.length < 8 || expected.length < 16) return false;
    // Parameters Argon2 itself rejects (e.g. memory below 8 KiB per lane) are a bad hash too.
    const actual = await derive(password, salt, settings, expected.length).catch(() => undefined);
    if (actual === undefined) return false;
    return timingSafeEqual(actual, expected);
  }
}
