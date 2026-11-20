import type { TenantId, UserId } from "@aep/domain";
import type { ChatModel } from "../models/chat-models.ts";
import type { AuditEventInput } from "../members/member-ports.ts";

export type ChatSettings = {
  /** Undefined: the instance default. */
  readonly model?: ChatModel;
  readonly updatedBy?: UserId;
  readonly updatedAt?: Date;
};

/** Every method takes tenantId; implementations scope reads and writes to it. */
export interface TenantSettings {
  chat(tenantId: TenantId): Promise<ChatSettings>;
  /** Stores the choice (undefined: back to the default) and writes `audit` with it. */
  setChat(
    tenantId: TenantId,
    change: { readonly model?: ChatModel; readonly by: UserId; readonly at: Date },
    audit: AuditEventInput,
  ): Promise<void>;
}
