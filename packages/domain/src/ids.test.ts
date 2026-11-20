import { describe, expect, it } from "vitest";
import { parseId } from "./ids.ts";

describe("parseId", () => {
  it("accepts a lowercase UUID and returns it as a branded id", () => {
    const result = parseId("TenantId", "0b6f8c1e-5a7d-4c2b-9e3f-1a2b3c4d5e6f");
    expect(result).toEqual({ ok: true, value: "0b6f8c1e-5a7d-4c2b-9e3f-1a2b3c4d5e6f" });
  });

  it("normalizes uppercase UUIDs to lowercase so equal ids compare equal", () => {
    const result = parseId("MissionId", "0B6F8C1E-5A7D-4C2B-9E3F-1A2B3C4D5E6F");
    expect(result).toEqual({ ok: true, value: "0b6f8c1e-5a7d-4c2b-9e3f-1a2b3c4d5e6f" });
  });

  it.each([
    "",
    "not-a-uuid",
    "0b6f8c1e5a7d4c2b9e3f1a2b3c4d5e6f",
    "0b6f8c1e-5a7d-4c2b-9e3f-1a2b3c4d5e6f ",
  ])("rejects %j", (raw) => {
    expect(parseId("UserId", raw)).toEqual({
      ok: false,
      error: { kind: "InvalidId", idType: "UserId" },
    });
  });
});
