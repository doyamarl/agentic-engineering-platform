import { MeDto } from "@aep/contracts";
import { cache } from "react";
import { callApi } from "./api";

/** The signed-in person, fetched once per request; undefined when not signed in. */
export const currentUser = cache(async (): Promise<MeDto | undefined> => {
  const result = await callApi("/v1/me", {}, MeDto);
  return result.ok ? result.value : undefined;
});

/** Whether the signed-in person's role allows `action` (e.g. "plan:approve"). */
export const allows = (me: MeDto | undefined, action: string): boolean =>
  me?.permissions.includes(action) === true;
