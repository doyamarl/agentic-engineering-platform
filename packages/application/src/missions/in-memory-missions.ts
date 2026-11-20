import { createHash } from "node:crypto";
import type { Mission, MissionId, TenantId, WorkspaceId } from "@aep/domain";
import { err, ok } from "@aep/domain";
import type { NewJob } from "../jobs/job-queue.ts";
import type {
  MissionChange,
  MissionEvent,
  MissionEventInput,
  MissionRepository,
  PlanDecision,
  StoredAcceptancePacket,
  StoredPlan,
} from "../ports.ts";

/**
 * In-memory MissionRepository with the same tenant scoping and optimistic versioning as the
 * Postgres adapter. Records events and outbox jobs for assertions.
 */
export class InMemoryMissions implements MissionRepository {
  readonly rows: Mission[] = [];
  readonly events: (MissionEventInput & { readonly missionId: MissionId })[] = [];
  readonly enqueued: NewJob[] = [];
  readonly plans: StoredPlan[] = [];
  readonly packets: StoredAcceptancePacket[] = [];
  /** The audit trail as listEvents serves it; `events` keeps the shorter form tests assert on. */
  readonly #log: (MissionEvent & { readonly tenantId: TenantId; readonly missionId: MissionId })[] =
    [];
  readonly decisions: (PlanDecision & {
    readonly missionId: MissionId;
    readonly tenantId: TenantId;
  })[] = [];
  readonly #workspaces: ReadonlyMap<TenantId, readonly WorkspaceId[]>;

  constructor(workspaces: ReadonlyMap<TenantId, readonly WorkspaceId[]>) {
    this.#workspaces = workspaces;
  }

  insert(mission: Mission) {
    if (!this.#workspaces.get(mission.tenantId)?.includes(mission.workspaceId)) {
      return Promise.resolve(err({ kind: "WorkspaceNotFound" } as const));
    }
    this.rows.push(mission);
    return Promise.resolve(ok(undefined));
  }

  findById(tenantId: TenantId, id: MissionId) {
    return Promise.resolve(this.rows.find((m) => m.tenantId === tenantId && m.id === id));
  }

  list(tenantId: TenantId, filter: { workspaceId?: WorkspaceId; limit: number }) {
    return Promise.resolve(
      this.rows
        .filter((m) => m.tenantId === tenantId)
        .filter((m) => filter.workspaceId === undefined || m.workspaceId === filter.workspaceId)
        .slice(0, filter.limit),
    );
  }

  recordTransition(change: MissionChange) {
    const { mission } = change;
    const index = this.rows.findIndex(
      (m) => m.tenantId === mission.tenantId && m.id === mission.id,
    );
    const stored = this.rows[index];
    if (stored?.version !== mission.version) {
      return Promise.resolve(err({ kind: "Conflict" } as const));
    }
    const { plan } = change;
    if (plan !== undefined) {
      const clash = this.plans.some(
        (p) =>
          p.tenantId === plan.tenantId &&
          p.missionId === plan.missionId &&
          p.version === plan.version,
      );
      if (clash) return Promise.resolve(err({ kind: "Conflict" } as const));
      const checksumSha256 = createHash("sha256").update(plan.body).digest("hex");
      this.plans.push({ ...plan, checksumSha256 });
    }
    const { packet } = change;
    if (packet !== undefined) {
      const clash = this.packets.some(
        (p) =>
          p.tenantId === packet.tenantId &&
          p.missionId === packet.missionId &&
          p.version === packet.version,
      );
      if (clash) return Promise.resolve(err({ kind: "Conflict" } as const));
      const content = JSON.stringify(packet.content);
      const checksumSha256 = createHash("sha256").update(content).digest("hex");
      this.packets.push({ ...packet, checksumSha256 });
    }
    if (change.decision !== undefined) {
      this.decisions.push({
        ...change.decision,
        decidedAt: change.at,
        missionId: mission.id,
        tenantId: mission.tenantId,
      });
    }
    const next: Mission = { ...stored, state: change.state, version: stored.version + 1 };
    this.rows[index] = next;
    this.events.push({ ...change.event, missionId: mission.id });
    const seq = this.#log.filter((e) => e.missionId === mission.id).length + 1;
    this.#log.push({
      ...change.event,
      seq,
      occurredAt: change.at,
      tenantId: mission.tenantId,
      missionId: mission.id,
    });
    if (change.enqueue !== undefined) this.enqueued.push(change.enqueue);
    return Promise.resolve(ok(next));
  }

  listEvents(
    tenantId: TenantId,
    missionId: MissionId,
    page: { readonly afterSeq?: number; readonly limit: number },
  ) {
    return Promise.resolve(
      this.#log
        .filter((e) => e.tenantId === tenantId && e.missionId === missionId)
        .filter((e) => e.seq > (page.afterSeq ?? 0))
        .slice(0, page.limit)
        .map(({ tenantId: _t, missionId: _m, ...event }): MissionEvent => event),
    );
  }

  listPlanDecisions(tenantId: TenantId, missionId: MissionId) {
    return Promise.resolve(
      this.decisions
        .filter((d) => d.tenantId === tenantId && d.missionId === missionId)
        .map(({ missionId: _m, tenantId: _t, ...decision }): PlanDecision => decision),
    );
  }

  findAcceptancePacket(tenantId: TenantId, missionId: MissionId, version?: number) {
    const own = this.packets.filter((p) => p.tenantId === tenantId && p.missionId === missionId);
    return Promise.resolve(
      version === undefined
        ? own.reduce<StoredAcceptancePacket | undefined>(
            (latest, p) => (latest === undefined || p.version > latest.version ? p : latest),
            undefined,
          )
        : own.find((p) => p.version === version),
    );
  }

  findPlanDecision(tenantId: TenantId, missionId: MissionId, planVersion: number) {
    const found = this.decisions.findLast(
      (d) => d.tenantId === tenantId && d.missionId === missionId && d.planVersion === planVersion,
    );
    if (found === undefined) return Promise.resolve(undefined);
    const { missionId: _m, tenantId: _t, ...decision } = found;
    return Promise.resolve(decision);
  }

  findPlan(tenantId: TenantId, missionId: MissionId, version?: number) {
    const own = this.plans.filter((p) => p.tenantId === tenantId && p.missionId === missionId);
    const found =
      version === undefined
        ? own.reduce<StoredPlan | undefined>(
            (latest, p) => (latest === undefined || p.version > latest.version ? p : latest),
            undefined,
          )
        : own.find((p) => p.version === version);
    return Promise.resolve(found);
  }
}
