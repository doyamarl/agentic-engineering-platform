import type { MissionId, TenantId, UserId } from "../ids.ts";
import type { MissionSource } from "./mission.ts";

// The acceptance packet (PRD FR-06): what a person needs to decide whether a mission's pull
// request is acceptable, gathered when verification passes. Each packet is an immutable version;
// release approval names the version it approves. Pure: the caller gathers the inputs.

export const ACCEPTANCE_PACKET_SCHEMA_VERSION = 1;

export type PacketCiCheck = {
  readonly name: string;
  readonly state: "pending" | "success" | "failure" | "neutral";
  readonly url: string | null;
};

export type PacketFile = {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
};

export type AcceptancePacketContent = {
  readonly schemaVersion: typeof ACCEPTANCE_PACKET_SCHEMA_VERSION;
  readonly mission: { readonly id: MissionId; readonly title: string };
  readonly source: MissionSource;
  readonly plan: {
    readonly version: number;
    readonly checksumSha256: string;
    /** The plan's "Acceptance criteria" section, or null if it has none. */
    readonly acceptanceCriteria: string | null;
    /** The plan's "Risks and assumptions" section, or null if it has none. */
    readonly risks: string | null;
  };
  readonly approvals: readonly {
    readonly subject: "plan";
    readonly version: number;
    readonly decision: "approved" | "rejected";
    readonly decidedBy: UserId;
    /** ISO 8601. */
    readonly decidedAt: string;
    readonly comment: string | null;
  }[];
  readonly pullRequest: {
    readonly number: number;
    readonly url: string;
    readonly branch: string;
    readonly commitSha: string;
  };
  readonly diff: {
    readonly files: readonly PacketFile[];
    readonly additions: number;
    readonly deletions: number;
    readonly truncated: boolean;
  };
  /** `none`: no CI result was reported for the commit within the wait. */
  readonly ci: { readonly state: "success" | "none"; readonly checks: readonly PacketCiCheck[] };
  /** Sum of the agent sessions' reported costs; null if none reported one. */
  readonly costUsd: number | null;
  /** What the packet does not establish; shown to the person deciding. */
  readonly residualRisks: readonly string[];
};

export type AcceptancePacket = {
  readonly tenantId: TenantId;
  readonly missionId: MissionId;
  /** 1, 2, ... per mission. */
  readonly version: number;
  readonly content: AcceptancePacketContent;
  readonly createdAt: Date;
};

/** The body of the `## <heading>` section of a Markdown plan, or null. */
export function planSection(body: string, heading: string): string | null {
  const lines = body.split("\n");
  const start = lines.findIndex(
    (line) => line.trim().toLowerCase() === `## ${heading.toLowerCase()}`,
  );
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{1,2}\s/.test(line));
  const section = (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
  return section === "" ? null : section;
}

export type PacketInput = {
  readonly tenantId: TenantId;
  readonly missionId: MissionId;
  readonly version: number;
  readonly createdAt: Date;
  readonly title: string;
  readonly source: MissionSource;
  readonly plan: {
    readonly version: number;
    readonly checksumSha256: string;
    readonly body: string;
  };
  readonly decisions: readonly {
    readonly planVersion: number;
    readonly decision: "approved" | "rejected";
    readonly decidedBy: UserId;
    readonly decidedAt: Date;
    readonly comment: string | null;
  }[];
  readonly pullRequest: AcceptancePacketContent["pullRequest"];
  readonly files: { readonly files: readonly PacketFile[]; readonly truncated: boolean };
  /** Finished CI results: none pending or failed (verification decides those first). */
  readonly checks: readonly PacketCiCheck[];
  readonly costUsd: number | null;
};

export function buildAcceptancePacket(input: PacketInput): AcceptancePacket {
  const unfinished = input.checks.filter((c) => c.state === "pending" || c.state === "failure");
  if (unfinished.length > 0) {
    throw new Error(
      `acceptance packet needs passing CI; got ${unfinished.map((c) => c.name).join(", ")}`,
    );
  }
  const acceptanceCriteria = planSection(input.plan.body, "Acceptance criteria");
  const neutral = input.checks.filter((c) => c.state === "neutral").map((c) => c.name);
  const residualRisks = [
    ...(input.checks.length === 0
      ? ["No CI result was reported for the pull request's commit, so no tests ran on it."]
      : []),
    ...(neutral.length > 0
      ? [`These checks finished without passing (skipped or neutral): ${neutral.join(", ")}.`]
      : []),
    acceptanceCriteria === null
      ? "The approved plan has no acceptance criteria."
      : "The plan's acceptance criteria have not been checked against the change automatically.",
    ...(input.files.truncated
      ? [`The pull request changes more files than the ${String(input.files.files.length)} listed.`]
      : []),
  ];
  const sum = (key: "additions" | "deletions") =>
    input.files.files.reduce((total, f) => total + f[key], 0);
  return {
    tenantId: input.tenantId,
    missionId: input.missionId,
    version: input.version,
    createdAt: input.createdAt,
    content: {
      schemaVersion: ACCEPTANCE_PACKET_SCHEMA_VERSION,
      mission: { id: input.missionId, title: input.title },
      source: input.source,
      plan: {
        version: input.plan.version,
        checksumSha256: input.plan.checksumSha256,
        acceptanceCriteria,
        risks: planSection(input.plan.body, "Risks and assumptions"),
      },
      approvals: input.decisions.map((d) => ({
        subject: "plan",
        version: d.planVersion,
        decision: d.decision,
        decidedBy: d.decidedBy,
        decidedAt: d.decidedAt.toISOString(),
        comment: d.comment,
      })),
      pullRequest: input.pullRequest,
      diff: {
        files: input.files.files,
        additions: sum("additions"),
        deletions: sum("deletions"),
        truncated: input.files.truncated,
      },
      ci: { state: input.checks.length === 0 ? "none" : "success", checks: input.checks },
      costUsd: input.costUsd,
      residualRisks,
    },
  };
}
