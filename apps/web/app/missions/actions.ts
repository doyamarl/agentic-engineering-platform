"use server";

// Mutations from the mission pages. Next.js checks the Origin of server action requests, so other
// sites cannot submit these forms on the viewer's behalf. Each action calls the API, then shows
// the mission again, with the API's message if it refused.

import { MissionDto } from "@aep/contracts";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { callApi, isUuid, type ApiResult } from "../lib/api";

const text = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
};

function back(path: string, result: ApiResult<unknown>): never {
  revalidatePath(path);
  redirect(result.ok ? path : `${path}?error=${encodeURIComponent(result.message)}`);
}

function missionPath(form: FormData): string {
  const id = text(form, "missionId");
  if (!isUuid(id)) throw new Error("invalid mission id");
  return `/missions/${id}`;
}

export async function createMission(form: FormData): Promise<never> {
  const issueNumber = Number(text(form, "issueNumber"));
  const result = await callApi(
    "/v1/missions",
    {
      method: "POST",
      body: {
        workspaceId: text(form, "workspaceId").trim(),
        title: text(form, "title"),
        source: {
          kind: "github_issue",
          owner: text(form, "owner").trim(),
          repo: text(form, "repo").trim(),
          issueNumber,
          baseBranch: text(form, "baseBranch").trim() || "main",
        },
      },
    },
    MissionDto,
  );
  if (!result.ok) {
    redirect(`/missions/new?error=${encodeURIComponent(result.message)}`);
  }
  revalidatePath("/missions");
  redirect(`/missions/${result.value.id}`);
}

export async function startPlanning(form: FormData): Promise<never> {
  const path = missionPath(form);
  back(path, await callApi(`/v1${path}/plan`, { method: "POST" }, MissionDto));
}

export async function approvePlan(form: FormData): Promise<never> {
  const path = missionPath(form);
  const comment = text(form, "comment").trim();
  const body = {
    planVersion: Number(text(form, "planVersion")),
    ...(comment === "" ? {} : { comment }),
  };
  back(path, await callApi(`/v1${path}/plan/approve`, { method: "POST", body }, MissionDto));
}

export async function rejectPlan(form: FormData): Promise<never> {
  const path = missionPath(form);
  const body = { planVersion: Number(text(form, "planVersion")), reason: text(form, "reason") };
  back(path, await callApi(`/v1${path}/plan/reject`, { method: "POST", body }, MissionDto));
}

export async function cancelMission(form: FormData): Promise<never> {
  const path = missionPath(form);
  back(path, await callApi(`/v1${path}/cancel`, { method: "POST" }, MissionDto));
}
