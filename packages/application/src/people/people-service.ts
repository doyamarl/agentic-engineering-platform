import { can, err, ok, type Result, type TenantId, type UserId } from "@aep/domain";
import type { AppError } from "../errors.ts";
import type { Principal } from "../principal.ts";

export type Person = { readonly userId: UserId; readonly displayName: string };

/** Implementations return `tenantId`'s members who are not disabled, by name. */
export interface PeopleDirectory {
  list(tenantId: TenantId): Promise<readonly Person[]>;
}

/** Who a thread can be shared with (ADR-014). Emails and roles stay with member:manage. */
export function peopleService({ people }: { readonly people: PeopleDirectory }) {
  return {
    async list(principal: Principal): Promise<Result<readonly Person[], AppError>> {
      if (!can(principal.role, "thread:read")) {
        return err({ kind: "Forbidden", action: "thread:read" });
      }
      return ok(await people.list(principal.tenantId));
    },
  };
}

export type PeopleService = ReturnType<typeof peopleService>;
