"use server";

// Mutations from the thread pages, like missions/actions.ts: each calls the API as the signed-in
// person and shows the page again, with the API's message if it refused.

import { DecideToolApprovalResponse, MessageDto, ThreadDto } from "@aep/contracts";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { callApi, isUuid, type ApiResult } from "../lib/api";

const text = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
};

function threadPath(form: FormData): string {
  const id = text(form, "threadId");
  if (!isUuid(id)) throw new Error("invalid thread id");
  return `/threads/${id}`;
}

function back(path: string, result: ApiResult<unknown>): never {
  revalidatePath(path);
  redirect(result.ok ? path : `${path}?error=${encodeURIComponent(result.message)}`);
}

export async function createThread(form: FormData): Promise<never> {
  const result = await callApi(
    "/v1/threads",
    {
      method: "POST",
      body: { workspaceId: text(form, "workspaceId").trim(), title: text(form, "title") },
    },
    ThreadDto,
  );
  if (!result.ok) redirect(`/threads?error=${encodeURIComponent(result.message)}`);
  revalidatePath("/threads");
  redirect(`/threads/${result.value.id}`);
}

const EFFORTS = new Set(["low", "medium", "high"]);

export async function postMessage(form: FormData): Promise<never> {
  const path = threadPath(form);
  const effort = text(form, "effort");
  back(
    path,
    await callApi(
      `/v1${path}/messages`,
      {
        method: "POST",
        body: { content: text(form, "content"), ...(EFFORTS.has(effort) ? { effort } : {}) },
      },
      MessageDto,
    ),
  );
}

export async function shareThread(form: FormData): Promise<never> {
  const path = threadPath(form);
  const kind = text(form, "kind");
  const memberIds = form.getAll("memberIds").filter((v): v is string => typeof v === "string");
  const body =
    kind === "members"
      ? { kind, memberIds: memberIds.filter(isUuid) }
      : { kind: kind === "workspace" ? "workspace" : "personal" };
  back(path, await callApi(`/v1${path}/visibility`, { method: "PUT", body }, ThreadDto));
}

/**
 * Approves or declines a connector write call the model asked for (ADR-013). The API lets only
 * the person whose connection the call would use decide.
 */
export async function decideToolApproval(form: FormData): Promise<never> {
  const path = threadPath(form);
  const approvalId = text(form, "approvalId");
  const decision = text(form, "decision");
  if (!isUuid(approvalId) || (decision !== "approve" && decision !== "reject")) {
    throw new Error("invalid decision");
  }
  const result = await callApi(
    `/v1${path}/tool-approvals/${approvalId}`,
    { method: "POST", body: { decision } },
    DecideToolApprovalResponse,
  );
  back(path, result);
}
