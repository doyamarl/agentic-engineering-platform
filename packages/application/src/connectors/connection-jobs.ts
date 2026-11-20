import type { TenantId, UserId } from "@aep/domain";
import type { NewJob } from "../jobs/job-queue.ts";

export const EXCHANGE_JOB = "connection.exchange";
export const DISCONNECT_JOB = "connection.disconnect";

/** Why a connection is being removed; recorded in the audit event. */
export type DisconnectReason = "user" | "admin" | "member_disabled";

/** Payload of `connection.exchange`. The code itself stays in the pending authorization row. */
export const exchangeJob = (
  tenantId: TenantId,
  userId: UserId,
  connectorId: string,
  state: string,
): NewJob => ({
  tenantId,
  kind: EXCHANGE_JOB,
  // The state is unique per attempt, so a repeated callback does not exchange the code twice.
  idempotencyKey: `${userId}:${connectorId}:${state}`,
  payload: { userId, connectorId },
  maxAttempts: 3,
});

export const disconnectJob = (
  tenantId: TenantId,
  userId: UserId,
  connectorId: string,
  reason: DisconnectReason,
  actorId: UserId | null,
  at: Date,
): NewJob => ({
  tenantId,
  kind: DISCONNECT_JOB,
  idempotencyKey: `${userId}:${connectorId}:${at.toISOString()}`,
  payload: { userId, connectorId, reason, actorId },
});

/** Ties a sealed token to its row: a ciphertext copied to another row cannot be opened. */
export const tokenContext = (
  tenantId: TenantId,
  userId: UserId,
  connectorId: string,
  kind: "access" | "refresh",
): string => `connection-token:${tenantId}:${userId}:${connectorId}:${kind}`;
