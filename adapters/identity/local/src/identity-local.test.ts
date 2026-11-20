import { createHmac, randomBytes } from "node:crypto";
import type { TenantId, UserId } from "@aep/domain";
import { describe, expect, it } from "vitest";
import { Argon2PasswordHasher, OWASP_ARGON2ID } from "./argon2-hasher.ts";
import { JwtAccessTokens } from "./jwt-access-tokens.ts";

describe("Argon2PasswordHasher", () => {
  const hasher = new Argon2PasswordHasher();

  it("writes an argon2id PHC string with the OWASP parameters and verifies it", async () => {
    const hash = await hasher.hash("correct horse battery");
    expect(hash).toMatch(
      /^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/,
    );
    expect(await hasher.verify(hash, "correct horse battery")).toBe(true);
    expect(await hasher.verify(hash, "correct horse batterY")).toBe(false);
  });

  it("salts every hash", async () => {
    expect(await hasher.hash("same password")).not.toBe(await hasher.hash("same password"));
  });

  it("verifies with the parameters stored in the hash, not the current settings", async () => {
    const old = await new Argon2PasswordHasher({ memory: 8192, passes: 3, parallelism: 1 }).hash(
      "pw",
    );
    expect(old).toContain("m=8192,t=3,p=1");
    expect(await new Argon2PasswordHasher(OWASP_ARGON2ID).verify(old, "pw")).toBe(true);
  });

  it.each([
    ["an empty string", ""],
    ["another algorithm", "$argon2i$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaA"],
    [
      "oversized memory",
      "$argon2id$v=19$m=9999999,t=2,p=1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaA",
    ],
    [
      "memory below what Argon2 accepts",
      "$argon2id$v=19$m=1,t=2,p=1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaA",
    ],
    ["zero passes", "$argon2id$v=19$m=19456,t=0,p=1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaA"],
  ])("answers false for %s instead of throwing", async (_, hash) => {
    expect(await hasher.verify(hash, "pw")).toBe(false);
  });
});

describe("JwtAccessTokens", () => {
  const secret = randomBytes(32);
  const codec = new JwtAccessTokens(secret);
  const claims = {
    userId: "0a000000-0000-4000-8000-0000000000aa" as UserId,
    tenantId: "0a000000-0000-4000-8000-000000000001" as TenantId,
    sessionId: "0a000000-0000-4000-8000-00000000c0de",
  };
  const inTenMinutes = () => new Date(Date.now() + 10 * 60_000);

  it("round-trips the claims", async () => {
    expect(await codec.verify(await codec.issue(claims, inTenMinutes()))).toEqual(claims);
  });

  it("refuses an expired token", async () => {
    expect(
      await codec.verify(await codec.issue(claims, new Date(Date.now() - 1000))),
    ).toBeUndefined();
  });

  it("refuses a token signed with another secret", async () => {
    const other = new JwtAccessTokens(randomBytes(32));
    expect(await codec.verify(await other.issue(claims, inTenMinutes()))).toBeUndefined();
  });

  const encode = (part: object) => Buffer.from(JSON.stringify(part)).toString("base64url");
  const payload = {
    iss: "aep",
    aud: "aep-api",
    sub: claims.userId,
    tid: claims.tenantId,
    sid: claims.sessionId,
    exp: Math.floor(Date.now() / 1000) + 600,
  };

  it("refuses an unsigned token (alg none)", async () => {
    const token = `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.`;
    expect(await codec.verify(token)).toBeUndefined();
  });

  it("refuses an HS512 token even under the right secret", async () => {
    const signingInput = `${encode({ alg: "HS512", typ: "JWT" })}.${encode(payload)}`;
    const signature = createHmac("sha512", secret).update(signingInput).digest("base64url");
    expect(await codec.verify(`${signingInput}.${signature}`)).toBeUndefined();
  });

  it.each([
    ["another audience", { aud: "someone-else" }],
    ["another issuer", { iss: "someone-else" }],
    ["a tenant that is not a UUID", { tid: "tenant-a" }],
    ["no session", { sid: undefined }],
  ])("refuses %s", async (_, change) => {
    const signingInput = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ ...payload, ...change })}`;
    const signature = createHmac("sha256", secret).update(signingInput).digest("base64url");
    expect(await codec.verify(`${signingInput}.${signature}`)).toBeUndefined();
  });

  it("refuses a secret shorter than 32 bytes", () => {
    expect(() => new JwtAccessTokens(randomBytes(31))).toThrow(/at least 32 bytes/);
  });
});
