import { describe, expect, it } from "vitest";
import { normalizeEmail, validateDisplayName, validatePassword } from "./credentials.ts";

describe("validatePassword", () => {
  it.each([
    ["11 characters", "a".repeat(11), false],
    ["12 characters", "a".repeat(12), true],
    ["256 characters", "a".repeat(256), true],
    ["257 characters", "a".repeat(257), false],
    ["12 emoji (24 UTF-16 units)", "🔑".repeat(12), true],
    ["11 emoji (22 UTF-16 units)", "🔑".repeat(11), false],
  ])("%s → %s", (_, password, valid) => {
    expect(validatePassword(password).ok).toBe(valid);
  });
});

describe("normalizeEmail", () => {
  it("trims and lower-cases", () => {
    expect(normalizeEmail("  Alice@Example.COM ")).toEqual({
      ok: true,
      value: "alice@example.com",
    });
  });

  it.each([
    "",
    "alice",
    "@example.com",
    "alice@",
    "a b@example.com",
    "a@b@c",
    `${"a".repeat(250)}@x.io`,
  ])("rejects %j", (email) => {
    expect(normalizeEmail(email)).toMatchObject({ ok: false, error: { field: "email" } });
  });
});

describe("validateDisplayName", () => {
  it("trims", () => {
    expect(validateDisplayName("  Alice ")).toEqual({ ok: true, value: "Alice" });
  });

  it.each(["", "   ", "a".repeat(201)])("rejects %j", (name) => {
    expect(validateDisplayName(name).ok).toBe(false);
  });
});
