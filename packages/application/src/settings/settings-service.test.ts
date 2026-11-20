import type { TenantId, UserId } from "@aep/domain";
import { describe, expect, it } from "vitest";
import type { AuditEventInput } from "../members/member-ports.ts";
import type { Principal } from "../principal.ts";
import type { ChatSettings, TenantSettings } from "./settings-ports.ts";
import { settingsService } from "./settings-service.ts";

const TENANT = "0a000000-0000-4000-8000-000000000001" as TenantId;
const NOW = new Date("2026-11-15T00:00:00Z");
const admin: Principal = {
  tenantId: TENANT,
  userId: "0a000000-0000-4000-8000-0000000000aa" as UserId,
  role: "admin",
};

function fake() {
  const stored = new Map<TenantId, ChatSettings>();
  const audit: AuditEventInput[] = [];
  const settings: TenantSettings = {
    chat: (tenantId) => Promise.resolve(stored.get(tenantId) ?? {}),
    setChat: (tenantId, change, event) => {
      stored.set(tenantId, {
        ...(change.model === undefined ? {} : { model: change.model }),
        updatedBy: change.by,
        updatedAt: change.at,
      });
      audit.push(event);
      return Promise.resolve();
    },
  };
  return { service: settingsService({ settings, now: () => NOW }), audit };
}

describe("settingsService", () => {
  it("starts on the instance default and lists the choices", async () => {
    expect(await fake().service.chat(admin)).toEqual({
      ok: true,
      value: { choices: ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"] },
    });
  });

  it("stores a choice, audits the change, and goes back to the default", async () => {
    const { service, audit } = fake();
    expect(await service.setChat(admin, "claude-opus-5-5")).toEqual({
      ok: true,
      value: { model: "claude-opus-5-5", updatedBy: admin.userId, updatedAt: NOW },
    });
    expect(await service.setChat(admin, null)).toMatchObject({ ok: true });
    expect(audit).toEqual([
      {
        type: "settings.chat_model_changed",
        actorId: admin.userId,
        subjectId: null,
        payload: { from: null, to: "claude-opus-5-5" },
      },
      {
        type: "settings.chat_model_changed",
        actorId: admin.userId,
        subjectId: null,
        payload: { from: "claude-opus-5-5", to: null },
      },
    ]);
    const current = await service.chat(admin);
    expect(current.ok && current.value.model).toBeUndefined();
  });

  it("rejects a model off the list", async () => {
    expect(await fake().service.setChat(admin, "gpt-5")).toMatchObject({
      ok: false,
      error: { kind: "Invalid", field: "model" },
    });
  });

  it.each(["planner", "engineer", "viewer"] as const)("is for admins, not a %s", async (role) => {
    const { service } = fake();
    const someone = { ...admin, role };
    expect(await service.chat(someone)).toEqual({
      ok: false,
      error: { kind: "Forbidden", action: "settings:manage" },
    });
    expect(await service.setChat(someone, null)).toMatchObject({ ok: false });
  });
});
