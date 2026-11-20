"use server";

// Member administration (permission member:manage, enforced by the API). Next.js checks the
// Origin of server action requests. An initial password comes back as the action's result, so
// it is shown once on the page that asked for it and never travels in a URL.

import { MemberDto, MemberWithPasswordDto } from "@aep/contracts";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { callApi, isUuid } from "../lib/api";

const text = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
};

/** What the create and reset forms show: the password to hand over, or why it failed. */
export type IssuedPassword =
  | { readonly kind: "idle" }
  | { readonly kind: "issued"; readonly email: string; readonly initialPassword: string }
  | { readonly kind: "failed"; readonly message: string };

const PATH = "/admin/members";

export async function createMember(_: IssuedPassword, form: FormData): Promise<IssuedPassword> {
  const result = await callApi(
    "/v1/members",
    {
      method: "POST",
      body: {
        displayName: text(form, "displayName"),
        email: text(form, "email"),
        role: text(form, "role"),
      },
    },
    MemberWithPasswordDto,
  );
  if (!result.ok) return { kind: "failed", message: result.message };
  revalidatePath(PATH);
  return {
    kind: "issued",
    email: result.value.member.email ?? "",
    initialPassword: result.value.initialPassword,
  };
}

export async function resetPassword(_: IssuedPassword, form: FormData): Promise<IssuedPassword> {
  const userId = text(form, "userId");
  if (!isUuid(userId)) return { kind: "failed", message: "メンバーが見つかりません" };
  const result = await callApi(
    `/v1/members/${userId}/password-reset`,
    { method: "POST" },
    MemberWithPasswordDto,
  );
  if (!result.ok) return { kind: "failed", message: result.message };
  revalidatePath(PATH);
  return {
    kind: "issued",
    email: result.value.member.email ?? "",
    initialPassword: result.value.initialPassword,
  };
}

/** Changes the role or the disabled flag, then shows the list again (with the API's refusal). */
export async function updateMember(form: FormData): Promise<never> {
  const userId = text(form, "userId");
  if (!isUuid(userId)) throw new Error("invalid member id");
  const role = text(form, "role");
  const disabled = text(form, "disabled");
  const body = {
    ...(role === "" ? {} : { role }),
    ...(disabled === "" ? {} : { disabled: disabled === "true" }),
  };
  const result = await callApi(`/v1/members/${userId}`, { method: "PATCH", body }, MemberDto);
  revalidatePath(PATH);
  redirect(result.ok ? PATH : `${PATH}?error=${encodeURIComponent(result.message)}`);
}
