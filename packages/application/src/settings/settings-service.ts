import { can, err, ok, type Result } from "@aep/domain";
import type { AppError } from "../errors.ts";
import { CHAT_MODELS, isChatModel, type ChatModel } from "../models/chat-models.ts";
import type { Principal } from "../principal.ts";
import type { ChatSettings, TenantSettings } from "./settings-ports.ts";

/** Tenant settings for admins (permission settings:manage). */
export function settingsService({
  settings,
  now,
}: {
  readonly settings: TenantSettings;
  readonly now: () => Date;
}) {
  return {
    async chat(
      principal: Principal,
    ): Promise<Result<ChatSettings & { readonly choices: readonly ChatModel[] }, AppError>> {
      if (!can(principal.role, "settings:manage")) {
        return err({ kind: "Forbidden", action: "settings:manage" });
      }
      return ok({ ...(await settings.chat(principal.tenantId)), choices: CHAT_MODELS });
    },

    /** `model` null goes back to the instance default. */
    async setChat(
      principal: Principal,
      model: string | null,
    ): Promise<Result<ChatSettings, AppError>> {
      if (!can(principal.role, "settings:manage")) {
        return err({ kind: "Forbidden", action: "settings:manage" });
      }
      if (model !== null && !isChatModel(model)) {
        return err({
          kind: "Invalid",
          field: "model",
          reason: `must be one of ${CHAT_MODELS.join(", ")} or null`,
        });
      }
      const before = await settings.chat(principal.tenantId);
      const at = now();
      await settings.setChat(
        principal.tenantId,
        { ...(model === null ? {} : { model }), by: principal.userId, at },
        {
          type: "settings.chat_model_changed",
          actorId: principal.userId,
          subjectId: null,
          payload: { from: before.model ?? null, to: model },
        },
      );
      return ok({
        ...(model === null ? {} : { model }),
        updatedBy: principal.userId,
        updatedAt: at,
      });
    },
  };
}

export type SettingsService = ReturnType<typeof settingsService>;
