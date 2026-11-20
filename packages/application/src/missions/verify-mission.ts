import { buildAcceptancePacket, type Mission } from "@aep/domain";
import type { GitPort } from "../git/git-port.ts";
import type { JobQueue } from "../jobs/job-queue.ts";
import type { JobHandler } from "../jobs/run-worker.ts";
import type { MissionEvent, MissionRepository } from "../ports.ts";
import { missionCommands } from "./mission-job.ts";
import { verificationJob } from "./mission-workflow.ts";

// The mission.verify job: watches the CI of the draft pull request that mission.execute opened,
// then gathers the acceptance packet (PRD FR-06) and moves the mission VERIFYING →
// ACCEPTANCE_READY (PassVerification), writing the packet in the same transaction.
//
// - A failed check fails the mission.
// - Pending checks: poll again (a new job, due after pollMs) until ciTimeoutMs, then fail.
// - No check at all: poll until noCiGraceMs, then accept and record that no CI ran.
//
// Elapsed time counts from the first poll (payload.startedAt). Errors reading GitHub throw, so the
// queue retries that poll.

export type VerifyMissionDeps = {
  readonly missions: MissionRepository;
  readonly git: Pick<GitPort, "readCiChecks" | "listPullRequestFiles">;
  readonly jobs: Pick<JobQueue, "enqueue">;
  readonly now: () => Date;
  /** Wait between polls. */
  readonly pollMs: number;
  /** How long to wait for a first CI result before accepting without CI. */
  readonly noCiGraceMs: number;
  /** How long to wait for pending checks before failing. */
  readonly ciTimeoutMs: number;
};

const MAX_REASON = 500;

type Delivery = {
  readonly branch: string;
  readonly commitSha: string;
  readonly number: number;
  readonly url: string;
};

/** The pull request the latest CompleteExecution event recorded. */
function deliveryOf(events: readonly MissionEvent[]): Delivery | undefined {
  const completed = events.findLast((e) => e.type === "CompleteExecution");
  if (completed === undefined) return undefined;
  const { branch, commitSha, pullRequestNumber, pullRequestUrl } = completed.payload;
  if (
    typeof branch !== "string" ||
    typeof commitSha !== "string" ||
    typeof pullRequestNumber !== "number" ||
    typeof pullRequestUrl !== "string"
  ) {
    return undefined;
  }
  return { branch, commitSha, number: pullRequestNumber, url: pullRequestUrl };
}

/** Sum of the costs agent sessions reported in events, rounded to micro-dollars; null if none. */
function totalCost(events: readonly MissionEvent[]): number | null {
  const costs = events.flatMap((e) =>
    typeof e.payload["costUsd"] === "number" ? [e.payload["costUsd"]] : [],
  );
  if (costs.length === 0) return null;
  return Math.round(costs.reduce((a, b) => a + b, 0) * 1e6) / 1e6;
}

const EVENT_PAGE = 500;

async function allEvents(
  missions: MissionRepository,
  mission: { readonly tenantId: Mission["tenantId"]; readonly id: Mission["id"] },
): Promise<MissionEvent[]> {
  const events: MissionEvent[] = [];
  for (;;) {
    const page = await missions.listEvents(mission.tenantId, mission.id, {
      afterSeq: events.at(-1)?.seq ?? 0,
      limit: EVENT_PAGE,
    });
    events.push(...page);
    if (page.length < EVENT_PAGE) return events;
  }
}

const minutes = (ms: number) => String(Math.round(ms / 60_000));

export function verifyMission(deps: VerifyMissionDeps): JobHandler {
  const { apply, load } = missionCommands(deps);

  return async (job) => {
    const mission = await load(job, "VERIFYING");
    if (mission?.state.status !== "VERIFYING") return;
    const { tenantId, id } = mission;
    const fail = (reason: string) =>
      apply(mission, { type: "Fail", reason: reason.slice(0, MAX_REASON) });

    const events = await allEvents(deps.missions, mission);
    const delivery = deliveryOf(events);
    if (delivery === undefined) {
      await fail("no pull request to verify");
      return;
    }
    const repository = { owner: mission.source.owner, name: mission.source.repo };
    const checks = await deps.git.readCiChecks(repository, delivery.commitSha);

    const now = deps.now();
    const startedAtText = job.payload["startedAt"];
    const startedAt = typeof startedAtText === "string" ? new Date(startedAtText) : now;
    const elapsed = now.getTime() - startedAt.getTime();
    const named = (state: string) => checks.filter((c) => c.state === state).map((c) => c.name);

    const failed = named("failure");
    if (failed.length > 0) {
      await fail(`CI failed: ${failed.join(", ")}`);
      return;
    }
    const pending = named("pending");
    const wait =
      (checks.length === 0 && elapsed < deps.noCiGraceMs) ||
      (pending.length > 0 && elapsed < deps.ciTimeoutMs);
    if (wait) {
      const poll = job.payload["poll"];
      const fromVersion = job.payload["fromVersion"];
      await deps.jobs.enqueue(
        verificationJob(mission, {
          fromVersion: typeof fromVersion === "number" ? fromVersion : mission.version,
          number: (typeof poll === "number" ? poll : 0) + 1,
          startedAt,
          runAfter: new Date(now.getTime() + deps.pollMs),
        }),
      );
      return;
    }
    if (pending.length > 0) {
      await fail(
        `CI did not finish within ${minutes(deps.ciTimeoutMs)} minutes: ${pending.join(", ")}`,
      );
      return;
    }

    const planVersion = mission.state.approvedPlanVersion;
    const plan = await deps.missions.findPlan(tenantId, id, planVersion);
    if (plan === undefined) {
      await fail(`approved plan version ${String(planVersion)} not found`);
      return;
    }
    const [files, decisions, latest] = await Promise.all([
      deps.git.listPullRequestFiles(repository, delivery.number),
      deps.missions.listPlanDecisions(tenantId, id),
      deps.missions.findAcceptancePacket(tenantId, id),
    ]);
    const packet = buildAcceptancePacket({
      tenantId,
      missionId: id,
      version: (latest?.version ?? 0) + 1,
      createdAt: now,
      title: mission.title,
      source: mission.source,
      plan,
      decisions,
      pullRequest: {
        number: delivery.number,
        url: delivery.url,
        branch: delivery.branch,
        commitSha: delivery.commitSha,
      },
      files,
      checks,
      costUsd: totalCost(events),
    });
    await apply(
      mission,
      { type: "PassVerification", packetVersion: packet.version },
      { packet, payload: { ci: packet.content.ci.state } },
    );
  };
}
