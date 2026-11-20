"use server";

// Tenant settings (permission settings:manage, enforced by the API).

import { ChatSettingsDto } from "@aep/contracts";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { callApi } from "../../lib/api";

const PATH = "/admin/settings";

export async function setChatModel(form: FormData): Promise<never> {
  const value = form.get("model");
  const model = typeof value === "string" && value !== "" ? value : null;
  const result = await callApi(
    "/v1/settings/chat",
    { method: "PUT", body: { model } },
    ChatSettingsDto,
  );
  revalidatePath(PATH);
  redirect(result.ok ? `${PATH}?saved=1` : `${PATH}?error=${encodeURIComponent(result.message)}`);
}
