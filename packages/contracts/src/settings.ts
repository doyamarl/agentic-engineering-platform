import { z } from "zod";

// Tenant settings for admins (/v1/settings, permission settings:manage).

/** `model` null: the instance default (the worker's AEP_CHAT_MODEL). */
export const ChatSettingsDto = z.object({
  model: z.string().nullable(),
  /** The models an admin may choose. */
  choices: z.array(z.string()),
  updatedBy: z.uuid().optional(),
  updatedAt: z.iso.datetime().optional(),
});
export type ChatSettingsDto = z.infer<typeof ChatSettingsDto>;

export const UpdateChatSettingsRequest = z.strictObject({
  model: z.string().max(200).nullable(),
});
export type UpdateChatSettingsRequest = z.infer<typeof UpdateChatSettingsRequest>;
