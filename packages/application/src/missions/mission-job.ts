import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { AcceptancePacket, Mission, MissionCommand, MissionId, Plan } from "@aep/domain";
import type { AgentOutcome, AgentPort, AgentTask, AgentUsage } from "../agents/agent-port.ts";
import type { Job, NewJob } from "../jobs/job-queue.ts";
import type { MissionEventInput, MissionRepository } from "../ports.ts";
import { applyTo } from "./mission-workflow.ts";

// Shared by the mission jobs (mission.plan, mission.execute): loading the job's mission, applying
// system commands that honour a concurrent cancellation, a scratch directory per attempt, and
// running one agent session to its finished event.

const SYSTEM = { kind: "system" } as const;
const MAX_REASON = 500;

export type MissionJobDeps = {
  readonly missions: MissionRepository;
  readonly agent: AgentPort;
  /** Checkouts go under <workRoot>/<tenant>/<mission>/<kind>-<attempt> and are removed afterwards. */
  readonly workRoot: string;
  readonly limits: AgentTask["limits"];
  readonly now: () => Date;
};

/**
 * `text` as a <tag> block of a prompt, which the text cannot close early: the agent reads it as
 * quoted data. Attribute values must be trusted (numbers, our own identifiers).
 */
export function quoted(tag: string, attributes: string, text: string): string {
  const safe = text.replaceAll(`</${tag}>`, `</ ${tag}>`);
  return [`<${tag}${attributes === "" ? "" : ` ${attributes}`}>`, safe, `</${tag}>`].join("\n");
}

export function failureReason(outcome: Exclude<AgentOutcome, { kind: "succeeded" }>): string {
  const text =
    outcome.kind === "failed"
      ? `agent failed (${outcome.reason}): ${outcome.detail}`
      : `agent ${outcome.kind.replace("_", " ")}`;
  return text.slice(0, MAX_REASON);
}

export class Interrupted extends Error {
  constructor(kind: string) {
    super(`${kind} interrupted; the job will be retried`);
    this.name = "Interrupted";
  }
}

export type AgentRun = {
  readonly outcome: AgentOutcome;
  readonly usage: AgentUsage | null;
  /** The adapter's provider name, e.g. `claude`. */
  readonly provider: string;
};

/** The parts of a mission job that need no agent: loading the mission and applying commands. */
export function missionCommands(deps: Pick<MissionJobDeps, "missions" | "now">) {
  /** Applies a command; on a version conflict re-reads once to honour a cancellation. */
  async function apply(
    mission: Mission,
    command: MissionCommand,
    options: {
      readonly payload?: MissionEventInput["payload"];
      readonly plan?: Plan;
      readonly packet?: AcceptancePacket;
      readonly actor?: MissionEventInput["actor"];
      readonly enqueue?: (mission: Mission) => NewJob;
    } = {},
  ): Promise<void> {
    const result = await applyTo(deps.missions, mission, {
      command,
      actor: options.actor ?? SYSTEM,
      now: deps.now(),
      ...(options.payload === undefined ? {} : { payload: options.payload }),
      ...(options.plan === undefined ? {} : { plan: options.plan }),
      ...(options.packet === undefined ? {} : { packet: options.packet }),
      ...(options.enqueue === undefined ? {} : { enqueue: options.enqueue }),
    });
    if (result.ok) return;
    if (result.error.kind === "Conflict" && (await confirmIfCancelled(mission))) return;
    throw new Error(`mission ${mission.id}: ${command.type} refused (${result.error.kind})`);
  }

  /** True if the mission was cancelled meanwhile (and is now confirmed cancelled). */
  async function confirmIfCancelled(mission: Mission): Promise<boolean> {
    const current = await deps.missions.findById(mission.tenantId, mission.id);
    if (current?.state.status !== "CANCEL_REQUESTED") return current?.state.status === "CANCELLED";
    await apply(current, { type: "ConfirmCancelled" });
    return true;
  }

  /**
   * The job's mission if it is in `status` and has a source; undefined (after confirming a
   * pending cancellation or failing a mission without source) if there is nothing to do.
   */
  async function load(
    job: Job,
    status: Mission["state"]["status"],
  ): Promise<(Mission & { readonly source: NonNullable<Mission["source"]> }) | undefined> {
    const missionId = job.payload["missionId"];
    if (typeof missionId !== "string") throw new Error(`${job.kind} needs payload.missionId`);
    const mission = await deps.missions.findById(job.tenantId, missionId as MissionId);
    if (mission === undefined) return undefined; // deleted or another tenant's id
    if (mission.state.status === "CANCEL_REQUESTED") {
      await apply(mission, { type: "ConfirmCancelled" });
      return undefined;
    }
    if (mission.state.status !== status) return undefined; // finished by an earlier attempt
    const { source } = mission;
    if (source === undefined) {
      await apply(mission, { type: "Fail", reason: "mission has no source to work from" });
      return undefined;
    }
    return { ...mission, source };
  }

  return { apply, confirmIfCancelled, load };
}

export function missionJob(deps: MissionJobDeps) {
  const { apply, confirmIfCancelled, load } = missionCommands(deps);

  /** Runs `work` in an empty scratch directory for this attempt, removed afterwards. */
  async function inScratchDirectory<T>(
    job: Job,
    mission: Mission,
    work: (directory: string) => Promise<T>,
  ): Promise<T> {
    const directory = join(
      deps.workRoot,
      mission.tenantId,
      mission.id,
      `${job.kind}-${String(job.attempt)}`,
    );
    await rm(directory, { recursive: true, force: true });
    try {
      return await work(directory);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  /** One agent session on `workdir`, cancelled when `signal` aborts. */
  async function runAgent(
    mission: Mission,
    task: { readonly prompt: string; readonly workdir: string },
    signal: AbortSignal,
  ): Promise<AgentRun> {
    const started = await deps.agent.start(
      { ...task, requires: new Set(), limits: deps.limits },
      { tenantId: mission.tenantId, missionId: mission.id },
    );
    if (!started.ok) throw new Error(`agent cannot run: missing ${started.error.missing.join()}`);
    const session = started.value;
    const onAbort = () => {
      void deps.agent.cancel(session);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      for await (const event of deps.agent.events(session)) {
        if (event.type === "finished") {
          return { outcome: event.outcome, usage: event.usage, provider: session.provider };
        }
      }
      throw new Error("agent ended without a finished event");
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  return { apply, confirmIfCancelled, load, inScratchDirectory, runAgent };
}
