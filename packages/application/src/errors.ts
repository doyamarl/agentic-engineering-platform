import type { Action } from "@aep/domain";

export type AppError =
  | { readonly kind: "Forbidden"; readonly action: Action }
  /** The caller may read the thread but only its owner may change who else can. */
  | { readonly kind: "NotOwner"; readonly resource: "thread" }
  /** Also returned for resources of other tenants, so their existence is not disclosed. */
  | {
      readonly kind: "NotFound";
      readonly resource:
        | "mission"
        | "workspace"
        | "plan"
        | "acceptance packet"
        | "member"
        | "thread"
        | "connector"
        | "tool approval"
        | "workspace repository";
    }
  | { readonly kind: "Invalid"; readonly field: string; readonly reason: string }
  /** The request is valid but the mission's current state does not allow it. */
  | { readonly kind: "Conflict"; readonly reason: string };
