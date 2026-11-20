"use server";

// Disconnecting a member (permission connector:manage, enforced by the API).

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { callApi, isUuid, NoContent } from "../../lib/api";

const PATH = "/admin/connections";

export async function disconnectMember(form: FormData): Promise<never> {
  const userId = form.get("userId");
  const connectorId = form.get("connectorId");
  if (typeof userId !== "string" || !isUuid(userId) || typeof connectorId !== "string") {
    redirect(`${PATH}?error=${encodeURIComponent("接続が見つかりません")}`);
  }
  const result = await callApi(
    `/v1/admin/connections/${userId}/${encodeURIComponent(connectorId)}`,
    { method: "DELETE" },
    NoContent,
  );
  revalidatePath(PATH);
  redirect(result.ok ? PATH : `${PATH}?error=${encodeURIComponent(result.message)}`);
}
