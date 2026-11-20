import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SealedSecret, SecretOpenError } from "@aep/application";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { aesGcmSecretBox, loadMasterKey } from "./aes-gcm-secret-box.ts";

const CONTEXT = "connection:tenant-a:user-a:amplitude";
const TOKEN = "sentinel-access-token-0123456789";

describe("aesGcmSecretBox", () => {
  const box = aesGcmSecretBox(randomBytes(32));

  it("opens what it sealed with the same context", () => {
    expect(box.open(box.seal(TOKEN, CONTEXT), CONTEXT)).toBe(TOKEN);
  });

  it("never stores the plaintext and uses a fresh IV each time", () => {
    const a = box.seal(TOKEN, CONTEXT);
    const b = box.seal(TOKEN, CONTEXT);
    expect(a).not.toContain(TOKEN);
    expect(a).not.toBe(b);
  });

  it("refuses another context, so a ciphertext copied to another person's row is useless", () => {
    const sealed = box.seal(TOKEN, CONTEXT);
    expect(() => box.open(sealed, "connection:tenant-a:user-b:amplitude")).toThrow(SecretOpenError);
  });

  it("refuses a changed ciphertext", () => {
    const sealed = box.seal(TOKEN, CONTEXT);
    const parts = sealed.split(".");
    const body = Buffer.from(parts[3] ?? "", "base64url");
    body[0] = (body[0] ?? 0) ^ 1;
    parts[3] = body.toString("base64url");
    expect(() => box.open(parts.join(".") as SealedSecret, CONTEXT)).toThrow(
      "authentication failed",
    );
  });

  it("says when the secret was sealed under another key", () => {
    const other = aesGcmSecretBox(randomBytes(32));
    expect(() => box.open(other.seal(TOKEN, CONTEXT), CONTEXT)).toThrow(
      "sealed under another master key",
    );
  });

  it.each(["", "v1.a.b", "v2.a.b.c", "v1.x.y.z"])("refuses malformed input %j", (input) => {
    expect(() => box.open(input as SealedSecret, CONTEXT)).toThrow(SecretOpenError);
  });

  it("refuses a key of the wrong length", () => {
    expect(() => aesGcmSecretBox(randomBytes(16))).toThrow("master key must be 32 bytes");
  });
});

describe("loadMasterKey", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "aep-master-key-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads 32 bytes in base64, ignoring the trailing newline", async () => {
    const key = randomBytes(32);
    await writeFile(join(dir, "key"), `${key.toString("base64")}\n`);
    expect(loadMasterKey(join(dir, "key")).equals(key)).toBe(true);
  });

  it.each([
    ["too short", randomBytes(16).toString("base64")],
    ["not base64", "x".repeat(44) + "!"],
    ["empty", ""],
  ])("refuses a key that is %s", async (_, content) => {
    await writeFile(join(dir, "key"), content);
    expect(() => loadMasterKey(join(dir, "key"))).toThrow("must hold 32 bytes in base64");
  });

  it("refuses a missing file", () => {
    expect(() => loadMasterKey(join(dir, "missing"))).toThrow("cannot be read");
  });
});
