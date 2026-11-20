import { err, ok, type Result } from "./result.ts";

declare const idBrand: unique symbol;

/** A UUID string that has been validated and tagged with the entity it identifies. */
export type Id<K extends IdType> = string & { readonly [idBrand]: K };

export type IdType = "TenantId" | "WorkspaceId" | "UserId" | "MissionId" | "ThreadId" | "MessageId";

export type TenantId = Id<"TenantId">;
export type WorkspaceId = Id<"WorkspaceId">;
export type UserId = Id<"UserId">;
export type MissionId = Id<"MissionId">;
export type ThreadId = Id<"ThreadId">;
export type MessageId = Id<"MessageId">;

export type InvalidId = { readonly kind: "InvalidId"; readonly idType: IdType };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseId<K extends IdType>(idType: K, raw: string): Result<Id<K>, InvalidId> {
  if (!UUID.test(raw)) {
    return err({ kind: "InvalidId", idType });
  }
  return ok(raw.toLowerCase() as Id<K>);
}
