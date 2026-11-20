"use server";

// Personal connections (permission connector:use, enforced by the API). Connecting sends the
// browser to the provider's authorization page; the provider sends it back to
// /connections/oauth/callback.

import { AuthorizeConnectorResponse } from "@aep/contracts";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { callApi, NoContent } from "../lib/api";

const PATH = "/connections";

const text = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
};

const failed = (message: string): never => redirect(`${PATH}?error=${encodeURIComponent(message)}`);

/** The provider's authorization page, if it is an http(s) URL; the API checked its host. */
function authorizationTarget(url: string): string | undefined {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "https:" || protocol === "http:" ? url : undefined;
  } catch {
    return undefined;
  }
}

export async function connect(form: FormData): Promise<never> {
  const connectorId = encodeURIComponent(text(form, "connectorId"));
  const serverId = text(form, "serverId");
  const result = await callApi(
    `/v1/connectors/${connectorId}/authorize`,
    { method: "POST", body: serverId === "" ? {} : { serverId } },
    AuthorizeConnectorResponse,
  );
  if (!result.ok) return failed(result.message);
  const target = authorizationTarget(result.value.authorizationUrl);
  if (target === undefined) return failed("接続先の認可ページの URL が不正です");
  redirect(target);
}

export async function disconnect(form: FormData): Promise<never> {
  const connectorId = encodeURIComponent(text(form, "connectorId"));
  const result = await callApi(`/v1/connections/${connectorId}`, { method: "DELETE" }, NoContent);
  revalidatePath(PATH);
  if (!result.ok) return failed(result.message);
  redirect(PATH);
}
