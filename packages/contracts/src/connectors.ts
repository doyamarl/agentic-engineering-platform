import { z } from "zod";

// Connectors and personal connections (ADR-013, #52). Never carries a token: a connection is
// reported by its status only.

export const ConnectionStatus = z.enum([
  "connecting",
  "failed",
  "connected",
  "expired",
  "disconnecting",
]);
export type ConnectionStatus = z.infer<typeof ConnectionStatus>;

export const ConnectionDto = z.object({
  connectorId: z.string(),
  serverId: z.string(),
  status: ConnectionStatus,
  connectedAt: z.iso.datetime().optional(),
  updatedAt: z.iso.datetime(),
  /** The provider's error code or a short reason when status is `failed`. */
  error: z.string().optional(),
});
export type ConnectionDto = z.infer<typeof ConnectionDto>;

export const ConnectorDto = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  servers: z.array(z.object({ id: z.string(), label: z.string() })),
  tools: z.array(z.object({ name: z.string(), class: z.enum(["read", "write"]) })),
  /** The caller's own connection; absent when never connected. */
  connection: ConnectionDto.optional(),
});
export type ConnectorDto = z.infer<typeof ConnectorDto>;

export const ConnectorListDto = z.object({ items: z.array(ConnectorDto) });
export type ConnectorListDto = z.infer<typeof ConnectorListDto>;

export const AuthorizeConnectorRequest = z.strictObject({
  /** Defaults to the connector's first server. */
  serverId: z.string().max(32).optional(),
});
export type AuthorizeConnectorRequest = z.infer<typeof AuthorizeConnectorRequest>;

export const AuthorizeConnectorResponse = z.object({ authorizationUrl: z.url() });
export type AuthorizeConnectorResponse = z.infer<typeof AuthorizeConnectorResponse>;

/** The query the provider sent to the web UI's callback, forwarded as it came. */
export const ConnectorCallbackRequest = z.strictObject({
  state: z.string().min(1).max(200),
  code: z.string().min(1).max(4096).optional(),
  iss: z.string().max(2048).optional(),
  error: z.string().max(200).optional(),
});
export type ConnectorCallbackRequest = z.infer<typeof ConnectorCallbackRequest>;

export const ConnectorCallbackResponse = z.object({ connectorId: z.string() });
export type ConnectorCallbackResponse = z.infer<typeof ConnectorCallbackResponse>;

/** For admins: who is connected to what. */
export const MemberConnectionDto = ConnectionDto.extend({ userId: z.uuid() });
export type MemberConnectionDto = z.infer<typeof MemberConnectionDto>;

export const MemberConnectionListDto = z.object({ items: z.array(MemberConnectionDto) });
export type MemberConnectionListDto = z.infer<typeof MemberConnectionListDto>;

/** The person whose connection a write tool would use decides it (#52 decision 2). */
export const DecideToolApprovalRequest = z.strictObject({
  decision: z.enum(["approve", "reject"]),
});
export type DecideToolApprovalRequest = z.infer<typeof DecideToolApprovalRequest>;

export const DecideToolApprovalResponse = z.object({
  /** Every write call of the paused reply is decided; the reply continues. */
  complete: z.boolean(),
});
export type DecideToolApprovalResponse = z.infer<typeof DecideToolApprovalResponse>;
