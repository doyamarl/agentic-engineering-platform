import { createHash, randomUUID } from "node:crypto";
import type {
  MissionChange,
  MissionEvent,
  MissionRepository,
  PlanDecision,
  StoredAcceptancePacket,
  StoredPlan,
} from "@aep/application";
import {
  err,
  ok,
  type Mission,
  type MissionId,
  type MissionSource,
  type MissionState,
  type Result,
  type TenantId,
  type UserId,
  type WorkspaceId,
} from "@aep/domain";
import { sql, type Kysely, type Selectable } from "kysely";
import { enqueueJob } from "./job-queue.ts";
import type {
  AcceptancePacketsTable,
  ApprovalsTable,
  Database,
  MissionsTable,
  PlansTable,
} from "./schema.ts";
import { withTenant } from "./tenant-session.ts";

const WORKSPACE_FK = "missions_tenant_id_workspace_id_fkey";
const VERSIONED_PKS = new Set(["plans_pkey", "acceptance_packets_pkey"]);

/** Thrown inside a transaction to roll it back and report a Conflict. */
class VersionTaken extends Error {}

const isForeignKeyViolation = (error: unknown, constraint: string): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "23503" &&
  "constraint" in error &&
  error.constraint === constraint;

function toMission(row: Selectable<MissionsTable>): Mission {
  // The status column is CHECK-constrained to equal state->>'status', and state is only written
  // from a MissionState by this adapter.
  return {
    tenantId: row.tenant_id as TenantId,
    workspaceId: row.workspace_id as WorkspaceId,
    id: row.id as MissionId,
    title: row.title,
    ...(row.source === null ? {} : { source: row.source as MissionSource }),
    state: row.state as MissionState,
    version: row.version,
    createdBy: row.created_by as UserId,
    createdAt: row.created_at,
  };
}

function toPlan(row: Selectable<PlansTable>): StoredPlan {
  return {
    tenantId: row.tenant_id as TenantId,
    missionId: row.mission_id as MissionId,
    version: row.version,
    body: row.body,
    author: {
      kind: row.author_kind,
      ...(row.author_id === null ? {} : { id: row.author_id }),
    },
    createdAt: row.created_at,
    checksumSha256: row.checksum_sha256,
  };
}

function toDecision(
  row: Pick<
    Selectable<ApprovalsTable>,
    "subject_version" | "decision" | "decided_by" | "comment" | "decided_at"
  >,
): PlanDecision {
  return {
    planVersion: row.subject_version,
    decision: row.decision,
    decidedBy: row.decided_by as UserId,
    comment: row.comment,
    decidedAt: row.decided_at,
  };
}

function toPacket(row: Selectable<AcceptancePacketsTable>): StoredAcceptancePacket {
  return {
    tenantId: row.tenant_id as TenantId,
    missionId: row.mission_id as MissionId,
    version: row.version,
    content: JSON.parse(row.content) as StoredAcceptancePacket["content"],
    createdAt: row.created_at,
    checksumSha256: row.checksum_sha256,
  };
}

const isVersionTaken = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "23505" &&
  "constraint" in error &&
  typeof error.constraint === "string" &&
  VERSIONED_PKS.has(error.constraint);

export class PostgresMissionRepository implements MissionRepository {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async insert(mission: Mission): Promise<Result<void, { readonly kind: "WorkspaceNotFound" }>> {
    try {
      await withTenant(this.#db, mission.tenantId, (trx) =>
        trx
          .insertInto("missions")
          .values({
            tenant_id: mission.tenantId,
            workspace_id: mission.workspaceId,
            id: mission.id,
            title: mission.title,
            status: mission.state.status,
            state: JSON.stringify(mission.state),
            source: mission.source === undefined ? null : JSON.stringify(mission.source),
            version: mission.version,
            created_by: mission.createdBy,
            created_at: mission.createdAt,
            updated_at: mission.createdAt,
          })
          .execute(),
      );
      return ok(undefined);
    } catch (error) {
      if (isForeignKeyViolation(error, WORKSPACE_FK)) return err({ kind: "WorkspaceNotFound" });
      throw error;
    }
  }

  async recordTransition(
    change: MissionChange,
  ): Promise<Result<Mission, { readonly kind: "Conflict" }>> {
    try {
      return await this.#record(change);
    } catch (error) {
      // A plan or packet insert failed after the mission update; the transaction rolled back.
      if (error instanceof VersionTaken) return err({ kind: "Conflict" } as const);
      throw error;
    }
  }

  #record(change: MissionChange): Promise<Result<Mission, { readonly kind: "Conflict" }>> {
    const { mission, state, event, at, plan, decision, packet } = change;
    return withTenant(this.#db, mission.tenantId, async (trx) => {
      // The row lock taken by this update also serialises the event sequence below.
      const row = await trx
        .updateTable("missions")
        .set({
          status: state.status,
          state: JSON.stringify(state),
          version: sql<number>`version + 1`,
          updated_at: at,
        })
        .where("tenant_id", "=", mission.tenantId)
        .where("id", "=", mission.id)
        .where("version", "=", mission.version)
        .returningAll()
        .executeTakeFirst();
      if (row === undefined) return err({ kind: "Conflict" } as const);
      await trx
        .insertInto("mission_events")
        .values({
          tenant_id: mission.tenantId,
          mission_id: mission.id,
          seq: sql<string>`(select coalesce(max(seq), 0) + 1 from mission_events
            where tenant_id = ${mission.tenantId} and mission_id = ${mission.id})`,
          type: event.type,
          payload: JSON.stringify(event.payload),
          actor_kind: event.actor.kind,
          actor_id: event.actor.id ?? null,
          occurred_at: at,
        })
        .execute();
      if (plan !== undefined) {
        if (plan.tenantId !== mission.tenantId || plan.missionId !== mission.id) {
          throw new Error("a plan can only be recorded with its own mission's change");
        }
        try {
          await trx
            .insertInto("plans")
            .values({
              tenant_id: plan.tenantId,
              mission_id: plan.missionId,
              version: plan.version,
              body: plan.body,
              checksum_sha256: createHash("sha256").update(plan.body, "utf8").digest("hex"),
              author_kind: plan.author.kind,
              author_id: plan.author.id ?? null,
              created_at: plan.createdAt,
            })
            .execute();
        } catch (error) {
          if (isVersionTaken(error)) throw new VersionTaken();
          throw error;
        }
      }
      if (decision !== undefined) {
        await trx
          .insertInto("approvals")
          .values({
            tenant_id: mission.tenantId,
            mission_id: mission.id,
            id: randomUUID(),
            subject: "plan",
            subject_version: decision.planVersion,
            decision: decision.decision,
            decided_by: decision.decidedBy,
            comment: decision.comment,
            decided_at: at,
          })
          .execute();
      }
      if (packet !== undefined) {
        if (packet.tenantId !== mission.tenantId || packet.missionId !== mission.id) {
          throw new Error("a packet can only be recorded with its own mission's change");
        }
        const content = JSON.stringify(packet.content);
        try {
          await trx
            .insertInto("acceptance_packets")
            .values({
              tenant_id: packet.tenantId,
              mission_id: packet.missionId,
              version: packet.version,
              content,
              checksum_sha256: createHash("sha256").update(content, "utf8").digest("hex"),
              created_at: packet.createdAt,
            })
            .execute();
        } catch (error) {
          if (isVersionTaken(error)) throw new VersionTaken();
          throw error;
        }
      }
      if (change.enqueue !== undefined) await enqueueJob(trx, change.enqueue);
      return ok(toMission(row));
    });
  }

  async listEvents(
    tenantId: TenantId,
    missionId: MissionId,
    page: { readonly afterSeq?: number; readonly limit: number },
  ): Promise<readonly MissionEvent[]> {
    const rows = await withTenant(this.#db, tenantId, (trx) =>
      trx
        .selectFrom("mission_events")
        .select(["seq", "type", "payload", "actor_kind", "actor_id", "occurred_at"])
        .where("tenant_id", "=", tenantId)
        .where("mission_id", "=", missionId)
        .where("seq", ">", String(page.afterSeq ?? 0))
        .orderBy("seq")
        .limit(page.limit)
        .execute(),
    );
    return rows.map((row) => ({
      seq: Number(row.seq),
      type: row.type,
      payload: row.payload as MissionEvent["payload"],
      actor: { kind: row.actor_kind, ...(row.actor_id === null ? {} : { id: row.actor_id }) },
      occurredAt: row.occurred_at,
    }));
  }

  async listPlanDecisions(
    tenantId: TenantId,
    missionId: MissionId,
  ): Promise<readonly PlanDecision[]> {
    const rows = await withTenant(this.#db, tenantId, (trx) =>
      trx
        .selectFrom("approvals")
        .select(["subject_version", "decision", "decided_by", "comment", "decided_at"])
        .where("tenant_id", "=", tenantId)
        .where("mission_id", "=", missionId)
        .where("subject", "=", "plan")
        .orderBy("decided_at")
        .orderBy("subject_version")
        .execute(),
    );
    return rows.map(toDecision);
  }

  async findAcceptancePacket(
    tenantId: TenantId,
    missionId: MissionId,
    version?: number,
  ): Promise<StoredAcceptancePacket | undefined> {
    const row = await withTenant(this.#db, tenantId, (trx) => {
      let query = trx
        .selectFrom("acceptance_packets")
        .selectAll()
        .where("tenant_id", "=", tenantId)
        .where("mission_id", "=", missionId);
      query =
        version === undefined
          ? query.orderBy("version", "desc").limit(1)
          : query.where("version", "=", version);
      return query.executeTakeFirst();
    });
    return row && toPacket(row);
  }

  async findPlanDecision(
    tenantId: TenantId,
    missionId: MissionId,
    planVersion: number,
  ): Promise<PlanDecision | undefined> {
    const row = await withTenant(this.#db, tenantId, (trx) =>
      trx
        .selectFrom("approvals")
        .select(["subject_version", "decision", "decided_by", "comment", "decided_at"])
        .where("tenant_id", "=", tenantId)
        .where("mission_id", "=", missionId)
        .where("subject", "=", "plan")
        .where("subject_version", "=", planVersion)
        .orderBy("decided_at", "desc")
        .limit(1)
        .executeTakeFirst(),
    );
    return row && toDecision(row);
  }

  async findPlan(
    tenantId: TenantId,
    missionId: MissionId,
    version?: number,
  ): Promise<StoredPlan | undefined> {
    const row = await withTenant(this.#db, tenantId, (trx) => {
      let query = trx
        .selectFrom("plans")
        .selectAll()
        .where("tenant_id", "=", tenantId)
        .where("mission_id", "=", missionId);
      query =
        version === undefined
          ? query.orderBy("version", "desc").limit(1)
          : query.where("version", "=", version);
      return query.executeTakeFirst();
    });
    return row && toPlan(row);
  }

  async findById(tenantId: TenantId, id: MissionId): Promise<Mission | undefined> {
    const row = await withTenant(this.#db, tenantId, (trx) =>
      trx
        .selectFrom("missions")
        .selectAll()
        .where("tenant_id", "=", tenantId)
        .where("id", "=", id)
        .executeTakeFirst(),
    );
    return row && toMission(row);
  }

  async list(
    tenantId: TenantId,
    filter: { readonly workspaceId?: WorkspaceId; readonly limit: number },
  ): Promise<readonly Mission[]> {
    const rows = await withTenant(this.#db, tenantId, (trx) => {
      let query = trx
        .selectFrom("missions")
        .selectAll()
        .where("tenant_id", "=", tenantId)
        .orderBy("created_at", "desc")
        .orderBy("id")
        .limit(filter.limit);
      if (filter.workspaceId !== undefined) {
        query = query.where("workspace_id", "=", filter.workspaceId);
      }
      return query.execute();
    });
    return rows.map(toMission);
  }
}
