import type {
  AppError,
  AuthService,
  IdentityPort,
  Member,
  MemberService,
  WorkspaceService,
  WorkspaceRepositoryService,
  WorkspaceRepository,
  MemberWithPassword,
  MissionService,
  Principal,
  StoredAcceptancePacket,
  StoredPlan,
  RefreshedTokens,
  ThreadService,
  PeopleService,
  SettingsService,
  ChatModel,
  Connection,
  ConnectionService,
  ToolApprovalService,
} from "@aep/application";
import { CHAT_MODELS } from "@aep/application";
import {
  ApprovePlanRequest,
  ChangePasswordRequest,
  CreateMemberRequest,
  ListAuditEventsQuery,
  LoginRequest,
  LogoutRequest,
  OidcCallbackRequest,
  RefreshRequest,
  CreateMissionRequest,
  ListEventsQuery,
  ListMissionsQuery,
  RejectPlanRequest,
  UpdateMemberRequest,
  CreateThreadRequest,
  ListMessagesQuery,
  ListThreadsQuery,
  PostMessageRequest,
  ShareThreadRequest,
  UpdateChatSettingsRequest,
  AuthorizeConnectorRequest,
  DecideToolApprovalRequest,
  ConnectorCallbackRequest,
  type AuthorizeConnectorResponse,
  type DecideToolApprovalResponse,
  type ConnectionDto,
  type ConnectorCallbackResponse,
  type ConnectorListDto,
  type MemberConnectionListDto,
  type ErrorDto,
  type AcceptancePacketDto,
  type AuditEventListDto,
  type MemberDto,
  type MemberListDto,
  type MemberWithPasswordDto,
  type MissionDto,
  type MissionEventListDto,
  type MissionListDto,
  type WorkspaceListDto,
  type WorkspaceRepositoryDto,
  type WorkspaceRepositoryListDto,
  type AuthMethodsDto,
  type MeDto,
  type OidcStartDto,
  type PlanDto,
  type TokensDto,
  type MessageDto,
  type MessageListDto,
  type ThreadDto,
  type ThreadEventListDto,
  type ThreadListDto,
  type PersonListDto,
  type ChatSettingsDto,
} from "@aep/contracts";
import {
  ACTIONS,
  can,
  parseId,
  type Mission,
  type MissionState,
  type Thread,
  type ThreadMessage,
  type UserId,
  type WorkspaceId,
} from "@aep/domain";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";

export type AppDependencies = {
  readonly identity: IdentityPort;
  readonly missions: MissionService;
  readonly members: MemberService;
  readonly threads: ThreadService;
  readonly people: PeopleService;
  readonly settings: SettingsService;
  readonly workspaces: WorkspaceService;
  /** The GitHub repositories each workspace's chat may read (#52). */
  readonly workspaceRepositories: WorkspaceRepositoryService;
  /** Personal connections to outside tools (ADR-013). Without it no connector is offered. */
  readonly connections?: ConnectionService;
  /** Decisions on connector write calls paused in a thread (ADR-013). With `connections`. */
  readonly toolApprovals?: ToolApprovalService;
  /** Login for people. Without it every /v1/auth route except /password answers 404. */
  readonly auth?: AuthService;
  /** Which methods `auth` offers (ADR-011: the operator enables them). */
  readonly authMethods?: { readonly password: boolean; readonly oidc?: { readonly name: string } };
  /** The OIDC redirect URI; the callback's query is appended to it for the code exchange. */
  readonly oidcRedirectUri?: URL;
};

/** Routes a principal that must change its password can still use. */
const PASSWORD_CHANGE_ROUTES = new Set(["/v1/me", "/v1/auth/password"]);

/** Ids the platform makes are UUIDs; anything else cannot name a row. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ErrorCode = ErrorDto["error"]["code"];

/** The plan versions and failure reason a client needs, without the internal state shape. */
function stateFields(
  state: MissionState,
): Pick<MissionDto, "planVersion" | "approvedPlanVersion" | "packetVersion" | "reason"> {
  switch (state.status) {
    case "AWAITING_PLAN_APPROVAL":
      return { planVersion: state.planVersion };
    case "APPROVED":
    case "EXECUTING":
    case "VERIFYING":
      return { approvedPlanVersion: state.approvedPlanVersion };
    case "ACCEPTANCE_READY":
    case "AWAITING_RELEASE_APPROVAL":
    case "COMPLETED":
      return {
        approvedPlanVersion: state.approvedPlanVersion,
        packetVersion: state.packetVersion,
      };
    case "FAILED":
    case "BLOCKED":
      return { ...stateFields(state.from), reason: state.reason };
    case "CANCEL_REQUESTED":
      return stateFields(state.from);
    case "DRAFT":
    case "PLANNING":
    case "CANCELLED":
      return {};
  }
}

const toDto = (mission: Mission): MissionDto => ({
  id: mission.id,
  workspaceId: mission.workspaceId,
  title: mission.title,
  ...(mission.source === undefined ? {} : { source: mission.source }),
  status: mission.state.status,
  ...stateFields(mission.state),
  version: mission.version,
  createdBy: mission.createdBy,
  createdAt: mission.createdAt.toISOString(),
});

const toPlanDto = (plan: StoredPlan): PlanDto => ({
  missionId: plan.missionId,
  version: plan.version,
  body: plan.body,
  checksumSha256: plan.checksumSha256,
  author: plan.author,
  createdAt: plan.createdAt.toISOString(),
});

const toPacketDto = (packet: StoredAcceptancePacket): AcceptancePacketDto => ({
  missionId: packet.missionId,
  version: packet.version,
  checksumSha256: packet.checksumSha256,
  createdAt: packet.createdAt.toISOString(),
  content: packet.content,
});

const toThreadDto = (thread: Thread): ThreadDto => ({
  id: thread.id,
  workspaceId: thread.workspaceId,
  ownerId: thread.ownerId,
  title: thread.title,
  visibility:
    thread.visibility.kind === "members"
      ? { kind: "members", memberIds: [...thread.visibility.memberIds] }
      : { kind: thread.visibility.kind },
  createdAt: thread.createdAt.toISOString(),
});

const toMessageDto = (message: ThreadMessage): MessageDto => ({
  id: message.id,
  threadId: message.threadId,
  role: message.role,
  ...(message.authorId === undefined ? {} : { authorId: message.authorId }),
  content: message.content,
  ...(message.effort === undefined ? {} : { effort: message.effort }),
  ...(message.model === undefined ? {} : { model: message.model }),
  ...(message.inReplyTo === undefined ? {} : { inReplyTo: message.inReplyTo }),
  createdAt: message.createdAt.toISOString(),
});

const toTokensDto = (tokens: RefreshedTokens): TokensDto => ({
  accessToken: tokens.accessToken,
  accessExpiresAt: tokens.accessExpiresAt.toISOString(),
  ...(tokens.refreshToken === undefined ? {} : { refreshToken: tokens.refreshToken }),
  refreshExpiresAt: tokens.refreshExpiresAt.toISOString(),
  mustChangePassword: tokens.mustChangePassword,
});

const toMemberDto = (member: Member): MemberDto => ({
  userId: member.userId,
  displayName: member.displayName,
  email: member.email,
  role: member.role,
  disabled: member.disabled,
  passwordLogin: member.passwordLogin,
  createdAt: member.createdAt.toISOString(),
});

/** The initial password is in the body: it must not be stored by browsers or proxies. */
const sendMemberWithPassword = (reply: FastifyReply, status: number, value: MemberWithPassword) =>
  reply
    .code(status)
    .header("cache-control", "no-store")
    .send({
      member: toMemberDto(value.member),
      initialPassword: value.initialPassword,
    } satisfies MemberWithPasswordDto);

/** Token responses must not be stored by browsers or proxies. */
const sendTokens = (reply: FastifyReply, tokens: RefreshedTokens) =>
  reply.header("cache-control", "no-store").send(toTokensDto(tokens));

/** A positive version number from a path segment, or undefined (answered like a missing one). */
const versionParam = (text: string): number | undefined =>
  /^[1-9][0-9]{0,8}$/.test(text) ? Number(text) : undefined;

const send = (reply: FastifyReply, status: number, code: ErrorCode, message: string) =>
  reply.code(status).send({ error: { code, message } } satisfies ErrorDto);

function sendAppError(reply: FastifyReply, error: AppError) {
  switch (error.kind) {
    case "Forbidden":
      return send(reply, 403, "forbidden", `missing permission ${error.action}`);
    case "NotOwner":
      return send(
        reply,
        403,
        "forbidden",
        `only the owner may change who can read the ${error.resource}`,
      );
    case "NotFound":
      return send(reply, 404, "not_found", `${error.resource} not found`);
    case "Invalid":
      return send(reply, 400, "invalid_request", `${error.field} ${error.reason}`);
    case "Conflict":
      return send(reply, 409, "conflict", error.reason);
  }
}

const notFoundMission = (reply: FastifyReply) =>
  sendAppError(reply, { kind: "NotFound", resource: "mission" });
const notFoundMember = (reply: FastifyReply) =>
  sendAppError(reply, { kind: "NotFound", resource: "member" });
const notFoundThread = (reply: FastifyReply) =>
  sendAppError(reply, { kind: "NotFound", resource: "thread" });

export function buildApp(deps: AppDependencies, options: { logger: boolean }): FastifyInstance {
  const app = Fastify({
    logger: options.logger && { redact: ["req.headers.authorization"] },
    bodyLimit: 64 * 1024,
  });

  // Principals are attached per request without widening FastifyRequest's type globally.
  const principals = new WeakMap<FastifyRequest, Principal>();
  const principalOf = (request: FastifyRequest): Principal => {
    const principal = principals.get(request);
    if (!principal) throw new Error("route registered outside the authenticated scope");
    return principal;
  };

  app.setErrorHandler((error, request, reply) => {
    const status =
      typeof error === "object" && error !== null && "statusCode" in error
        ? error.statusCode
        : undefined;
    if (typeof status === "number" && status >= 400 && status < 500) {
      return send(reply, status, "invalid_request", "request could not be parsed");
    }
    request.log.error(error);
    return send(reply, 500, "internal", "internal error");
  });

  app.get("/healthz", () => ({ status: "ok" }));

  void app.register(
    (v1, _opts, done) => {
      v1.addHook("onRequest", async (request, reply) => {
        const header = request.headers.authorization;
        const credential = header?.startsWith("Bearer ")
          ? header.slice("Bearer ".length)
          : undefined;
        const principal =
          credential === undefined ? undefined : await deps.identity.authenticate(credential);
        if (!principal) {
          reply.header("www-authenticate", "Bearer");
          return send(reply, 401, "unauthorized", "missing or invalid bearer token");
        }
        principals.set(request, principal);
        if (
          principal.mustChangePassword === true &&
          !PASSWORD_CHANGE_ROUTES.has(request.routeOptions.url ?? "")
        ) {
          return send(reply, 403, "password_change_required", "change your password first");
        }
      });

      v1.get("/me", (request, reply) => {
        const principal = principalOf(request);
        return reply.send({
          userId: principal.userId,
          tenantId: principal.tenantId,
          role: principal.role,
          mustChangePassword: principal.mustChangePassword === true,
          permissions: ACTIONS.filter((action) => can(principal.role, action)),
        } satisfies MeDto);
      });

      // Tenant administration (permission member:manage).
      v1.get("/members", async (request, reply) => {
        const result = await deps.members.list(principalOf(request));
        return result.ok
          ? reply.send({ items: result.value.map(toMemberDto) } satisfies MemberListDto)
          : sendAppError(reply, result.error);
      });

      v1.post("/members", async (request, reply) => {
        const body = CreateMemberRequest.safeParse(request.body);
        if (!body.success) return send(reply, 400, "invalid_request", body.error.message);
        const result = await deps.members.create(principalOf(request), body.data);
        return result.ok
          ? sendMemberWithPassword(reply, 201, result.value)
          : sendAppError(reply, result.error);
      });

      v1.patch<{ Params: { userId: string } }>("/members/:userId", async (request, reply) => {
        const userId = parseId("UserId", request.params.userId);
        if (!userId.ok) return notFoundMember(reply);
        const body = UpdateMemberRequest.safeParse(request.body);
        if (!body.success) return send(reply, 400, "invalid_request", body.error.message);
        const result = await deps.members.update(principalOf(request), userId.value, {
          ...(body.data.role === undefined ? {} : { role: body.data.role }),
          ...(body.data.disabled === undefined ? {} : { disabled: body.data.disabled }),
        });
        return result.ok
          ? reply.send(toMemberDto(result.value))
          : sendAppError(reply, result.error);
      });

      v1.post<{ Params: { userId: string } }>(
        "/members/:userId/password-reset",
        async (request, reply) => {
          const userId = parseId("UserId", request.params.userId);
          if (!userId.ok) return notFoundMember(reply);
          const result = await deps.members.resetPassword(principalOf(request), userId.value);
          return result.ok
            ? sendMemberWithPassword(reply, 200, result.value)
            : sendAppError(reply, result.error);
        },
      );

      v1.get("/audit-events", async (request, reply) => {
        const query = ListAuditEventsQuery.safeParse(request.query);
        if (!query.success) return send(reply, 400, "invalid_request", query.error.message);
        const result = await deps.members.listAudit(principalOf(request), {
          ...(query.data.after === undefined ? {} : { afterId: query.data.after }),
          ...(query.data.limit === undefined ? {} : { limit: query.data.limit }),
        });
        if (!result.ok) return sendAppError(reply, result.error);
        const items = result.value.map((event) => ({
          id: event.id,
          type: event.type,
          actorId: event.actorId,
          subjectId: event.subjectId,
          payload: event.payload,
          occurredAt: event.occurredAt.toISOString(),
        }));
        return reply.send({ items } satisfies AuditEventListDto);
      });

      // Replaces the caller's password; every session of the user ends and a new one starts.
      v1.post("/auth/password", async (request, reply) => {
        if (deps.auth === undefined) return send(reply, 404, "not_found", "password login is off");
        const body = ChangePasswordRequest.safeParse(request.body);
        if (!body.success) return send(reply, 400, "invalid_request", "invalid password change");
        const result = await deps.auth.changePassword(
          principalOf(request),
          body.data.currentPassword,
          body.data.newPassword,
        );
        return result.ok ? sendTokens(reply, result.value) : sendAppError(reply, result.error);
      });

      v1.post("/missions", async (request, reply) => {
        const body = CreateMissionRequest.safeParse(request.body);
        if (!body.success) return send(reply, 400, "invalid_request", body.error.message);
        const workspaceId = parseId("WorkspaceId", body.data.workspaceId);
        if (!workspaceId.ok) return send(reply, 400, "invalid_request", "workspaceId is invalid");

        const result = await deps.missions.create(principalOf(request), {
          workspaceId: workspaceId.value,
          title: body.data.title,
          ...(body.data.source === undefined ? {} : { source: body.data.source }),
        });
        return result.ok
          ? reply.code(201).send(toDto(result.value))
          : sendAppError(reply, result.error);
      });

      v1.get("/workspaces", async (request, reply) => {
        const result = await deps.workspaces.list(principalOf(request));
        return result.ok
          ? reply.send({ items: [...result.value] } satisfies WorkspaceListDto)
          : sendAppError(reply, result.error);
      });

      // The GitHub repositories a workspace's chat may read (#52 scope 7).
      const toWorkspaceRepositoryDto = (r: WorkspaceRepository): WorkspaceRepositoryDto => ({
        owner: r.owner,
        name: r.name,
        addedBy: r.addedBy,
        addedAt: r.addedAt.toISOString(),
      });
      const notFoundWorkspace = (reply: FastifyReply) =>
        sendAppError(reply, { kind: "NotFound", resource: "workspace" });

      v1.get<{ Params: { id: string } }>("/workspaces/:id/repositories", async (request, reply) => {
        const workspaceId = parseId("WorkspaceId", request.params.id);
        if (!workspaceId.ok) return notFoundWorkspace(reply);
        const result = await deps.workspaceRepositories.list(
          principalOf(request),
          workspaceId.value,
        );
        return result.ok
          ? reply.send({
              items: result.value.map(toWorkspaceRepositoryDto),
            } satisfies WorkspaceRepositoryListDto)
          : sendAppError(reply, result.error);
      });

      v1.put<{ Params: { id: string; owner: string; name: string } }>(
        "/workspaces/:id/repositories/:owner/:name",
        async (request, reply) => {
          const workspaceId = parseId("WorkspaceId", request.params.id);
          if (!workspaceId.ok) return notFoundWorkspace(reply);
          const result = await deps.workspaceRepositories.add(
            principalOf(request),
            workspaceId.value,
            { owner: request.params.owner, name: request.params.name },
          );
          if (!result.ok) return sendAppError(reply, result.error);
          return reply
            .code(result.value.added ? 201 : 200)
            .send(toWorkspaceRepositoryDto(result.value.repository));
        },
      );

      v1.delete<{ Params: { id: string; owner: string; name: string } }>(
        "/workspaces/:id/repositories/:owner/:name",
        async (request, reply) => {
          const workspaceId = parseId("WorkspaceId", request.params.id);
          if (!workspaceId.ok) return notFoundWorkspace(reply);
          const result = await deps.workspaceRepositories.remove(
            principalOf(request),
            workspaceId.value,
            { owner: request.params.owner, name: request.params.name },
          );
          return result.ok ? reply.code(204).send() : sendAppError(reply, result.error);
        },
      );

      v1.get("/missions", async (request, reply) => {
        const query = ListMissionsQuery.safeParse(request.query);
        if (!query.success) return send(reply, 400, "invalid_request", query.error.message);

        let filter: { workspaceId?: WorkspaceId; limit?: number } = {};
        if (query.data.workspaceId !== undefined) {
          const workspaceId = parseId("WorkspaceId", query.data.workspaceId);
          if (!workspaceId.ok) return send(reply, 400, "invalid_request", "workspaceId is invalid");
          filter = { workspaceId: workspaceId.value };
        }
        if (query.data.limit !== undefined) filter = { ...filter, limit: query.data.limit };

        const result = await deps.missions.list(principalOf(request), filter);
        return result.ok
          ? reply.send({ items: result.value.map(toDto) } satisfies MissionListDto)
          : sendAppError(reply, result.error);
      });

      v1.get<{ Params: { id: string } }>("/missions/:id", async (request, reply) => {
        // A malformed id cannot name any mission, so it gets the same answer as a missing one.
        const id = parseId("MissionId", request.params.id);
        if (!id.ok) return notFoundMission(reply);
        const result = await deps.missions.get(principalOf(request), id.value);
        return result.ok ? reply.send(toDto(result.value)) : sendAppError(reply, result.error);
      });

      // The audit trail. Clients follow it by passing the last seq they saw as `after`.
      v1.get<{ Params: { id: string } }>("/missions/:id/events", async (request, reply) => {
        const id = parseId("MissionId", request.params.id);
        if (!id.ok) return notFoundMission(reply);
        const query = ListEventsQuery.safeParse(request.query);
        if (!query.success) return send(reply, 400, "invalid_request", query.error.message);
        const result = await deps.missions.listEvents(principalOf(request), id.value, {
          ...(query.data.after === undefined ? {} : { afterSeq: query.data.after }),
          ...(query.data.limit === undefined ? {} : { limit: query.data.limit }),
        });
        if (!result.ok) return sendAppError(reply, result.error);
        const items = result.value.map((event) => ({
          seq: event.seq,
          type: event.type,
          payload: event.payload,
          actor: event.actor,
          occurredAt: event.occurredAt.toISOString(),
        }));
        return reply.send({ items } satisfies MissionEventListDto);
      });

      // Cancels; work in progress stops at the job's next step (202 with CANCEL_REQUESTED).
      v1.post<{ Params: { id: string } }>("/missions/:id/cancel", async (request, reply) => {
        const id = parseId("MissionId", request.params.id);
        if (!id.ok) return notFoundMission(reply);
        const result = await deps.missions.cancel(principalOf(request), id.value);
        if (!result.ok) return sendAppError(reply, result.error);
        return reply
          .code(result.value.state.status === "CANCELLED" ? 200 : 202)
          .send(toDto(result.value));
      });

      // Starts planning: the plan is written by an agent in the background (202).
      v1.post<{ Params: { id: string } }>("/missions/:id/plan", async (request, reply) => {
        const id = parseId("MissionId", request.params.id);
        if (!id.ok) return notFoundMission(reply);
        const result = await deps.missions.startPlanning(principalOf(request), id.value);
        return result.ok
          ? reply.code(202).send(toDto(result.value))
          : sendAppError(reply, result.error);
      });

      // Approves a plan version and starts executing it in the background (202).
      v1.post<{ Params: { id: string } }>("/missions/:id/plan/approve", async (request, reply) => {
        const id = parseId("MissionId", request.params.id);
        if (!id.ok) return notFoundMission(reply);
        const body = ApprovePlanRequest.safeParse(request.body);
        if (!body.success) return send(reply, 400, "invalid_request", body.error.message);
        const result = await deps.missions.approvePlan(principalOf(request), id.value, {
          planVersion: body.data.planVersion,
          ...(body.data.comment === undefined ? {} : { comment: body.data.comment }),
        });
        return result.ok
          ? reply.code(202).send(toDto(result.value))
          : sendAppError(reply, result.error);
      });

      // Rejects a plan version; an agent writes the next one in the background (202).
      v1.post<{ Params: { id: string } }>("/missions/:id/plan/reject", async (request, reply) => {
        const id = parseId("MissionId", request.params.id);
        if (!id.ok) return notFoundMission(reply);
        const body = RejectPlanRequest.safeParse(request.body);
        if (!body.success) return send(reply, 400, "invalid_request", body.error.message);
        const result = await deps.missions.rejectPlan(principalOf(request), id.value, body.data);
        return result.ok
          ? reply.code(202).send(toDto(result.value))
          : sendAppError(reply, result.error);
      });

      v1.get<{ Params: { id: string } }>("/missions/:id/plan", async (request, reply) => {
        const id = parseId("MissionId", request.params.id);
        if (!id.ok) return notFoundMission(reply);
        const result = await deps.missions.getPlan(principalOf(request), id.value);
        return result.ok ? reply.send(toPlanDto(result.value)) : sendAppError(reply, result.error);
      });

      v1.get<{ Params: { id: string; version: string } }>(
        "/missions/:id/plans/:version",
        async (request, reply) => {
          const id = parseId("MissionId", request.params.id);
          if (!id.ok) return notFoundMission(reply);
          // Like a malformed id, a malformed version cannot name a plan.
          const version = versionParam(request.params.version);
          const result =
            version === undefined
              ? ({ ok: false, error: { kind: "NotFound", resource: "plan" } } as const)
              : await deps.missions.getPlan(principalOf(request), id.value, version);
          return result.ok
            ? reply.send(toPlanDto(result.value))
            : sendAppError(reply, result.error);
        },
      );

      v1.get<{ Params: { id: string } }>(
        "/missions/:id/acceptance-packet",
        async (request, reply) => {
          const id = parseId("MissionId", request.params.id);
          if (!id.ok) return notFoundMission(reply);
          const result = await deps.missions.getAcceptancePacket(principalOf(request), id.value);
          return result.ok
            ? reply.send(toPacketDto(result.value))
            : sendAppError(reply, result.error);
        },
      );

      v1.get<{ Params: { id: string; version: string } }>(
        "/missions/:id/acceptance-packets/:version",
        async (request, reply) => {
          const id = parseId("MissionId", request.params.id);
          if (!id.ok) return notFoundMission(reply);
          const version = versionParam(request.params.version);
          const result =
            version === undefined
              ? ({ ok: false, error: { kind: "NotFound", resource: "acceptance packet" } } as const)
              : await deps.missions.getAcceptancePacket(principalOf(request), id.value, version);
          return result.ok
            ? reply.send(toPacketDto(result.value))
            : sendAppError(reply, result.error);
        },
      );

      // Threads (ADR-014). A thread the caller may not read answers 404, like a missing one.
      v1.post("/threads", async (request, reply) => {
        const body = CreateThreadRequest.safeParse(request.body);
        if (!body.success) return send(reply, 400, "invalid_request", body.error.message);
        const workspaceId = parseId("WorkspaceId", body.data.workspaceId);
        if (!workspaceId.ok) return send(reply, 400, "invalid_request", "workspaceId is invalid");
        const result = await deps.threads.create(principalOf(request), {
          workspaceId: workspaceId.value,
          title: body.data.title,
        });
        return result.ok
          ? reply.code(201).send(toThreadDto(result.value))
          : sendAppError(reply, result.error);
      });

      v1.get("/threads", async (request, reply) => {
        const query = ListThreadsQuery.safeParse(request.query);
        if (!query.success) return send(reply, 400, "invalid_request", query.error.message);
        let filter: { workspaceId?: WorkspaceId; limit?: number } = {};
        if (query.data.workspaceId !== undefined) {
          const workspaceId = parseId("WorkspaceId", query.data.workspaceId);
          if (!workspaceId.ok) return send(reply, 400, "invalid_request", "workspaceId is invalid");
          filter = { workspaceId: workspaceId.value };
        }
        if (query.data.limit !== undefined) filter = { ...filter, limit: query.data.limit };
        const result = await deps.threads.list(principalOf(request), filter);
        return result.ok
          ? reply.send({ items: result.value.map(toThreadDto) } satisfies ThreadListDto)
          : sendAppError(reply, result.error);
      });

      // Tenant settings (permission settings:manage).
      const toChatSettingsDto = (
        value: {
          readonly model?: string;
          readonly updatedBy?: string;
          readonly updatedAt?: Date;
        },
        choices: readonly ChatModel[],
      ): ChatSettingsDto => ({
        model: value.model ?? null,
        choices: [...choices],
        ...(value.updatedBy === undefined ? {} : { updatedBy: value.updatedBy }),
        ...(value.updatedAt === undefined ? {} : { updatedAt: value.updatedAt.toISOString() }),
      });

      v1.get("/settings/chat", async (request, reply) => {
        const result = await deps.settings.chat(principalOf(request));
        return result.ok
          ? reply.send(toChatSettingsDto(result.value, result.value.choices))
          : sendAppError(reply, result.error);
      });

      v1.put("/settings/chat", async (request, reply) => {
        const body = UpdateChatSettingsRequest.safeParse(request.body);
        if (!body.success) return send(reply, 400, "invalid_request", body.error.message);
        const result = await deps.settings.setChat(principalOf(request), body.data.model);
        return result.ok
          ? reply.send(toChatSettingsDto(result.value, CHAT_MODELS))
          : sendAppError(reply, result.error);
      });

      // Connectors and personal connections (ADR-013, #52). Tokens never pass through here: the
      // worker exchanges the code and seals the tokens (#52 decision 6).
      const toConnectionDto = (c: Connection): ConnectionDto => ({
        connectorId: c.connectorId,
        serverId: c.serverId,
        status: c.status,
        ...(c.connectedAt === undefined ? {} : { connectedAt: c.connectedAt.toISOString() }),
        updatedAt: c.updatedAt.toISOString(),
        ...(c.error === undefined ? {} : { error: c.error }),
      });
      const notFoundConnector = (reply: FastifyReply) =>
        sendAppError(reply, { kind: "NotFound", resource: "connector" });

      v1.get("/connectors", async (request, reply) => {
        if (deps.connections === undefined) {
          return reply.send({ items: [] } satisfies ConnectorListDto);
        }
        const result = await deps.connections.list(principalOf(request));
        if (!result.ok) return sendAppError(reply, result.error);
        return reply.send({
          items: result.value.map(({ manifest, connection }) => ({
            id: manifest.id,
            name: manifest.name,
            description: manifest.description,
            servers: manifest.servers.map((s) => ({ id: s.id, label: s.label })),
            tools: manifest.tools.map((t) => ({ name: t.name, class: t.class })),
            ...(connection === undefined ? {} : { connection: toConnectionDto(connection) }),
          })),
        } satisfies ConnectorListDto);
      });

      v1.post<{ Params: { id: string } }>("/connectors/:id/authorize", async (request, reply) => {
        if (deps.connections === undefined) return notFoundConnector(reply);
        const body = AuthorizeConnectorRequest.safeParse(request.body ?? {});
        if (!body.success) return send(reply, 400, "invalid_request", body.error.message);
        let result;
        try {
          result = await deps.connections.authorize(
            principalOf(request),
            request.params.id,
            body.data.serverId,
          );
        } catch (error) {
          // Discovery or registration at the provider failed; nothing was stored.
          request.log.warn({ err: error, connector: request.params.id }, "authorize failed");
          return send(reply, 502, "bad_gateway", "the connector's authorization server failed");
        }
        return result.ok
          ? reply
              .header("cache-control", "no-store")
              .send({ authorizationUrl: result.value.url } satisfies AuthorizeConnectorResponse)
          : sendAppError(reply, result.error);
      });

      v1.post("/connections/oauth/callback", async (request, reply) => {
        if (deps.connections === undefined) return notFoundConnector(reply);
        const body = ConnectorCallbackRequest.safeParse(request.body);
        if (!body.success) return send(reply, 400, "invalid_request", body.error.message);
        const { state, code, iss, error } = body.data;
        const result = await deps.connections.callback(principalOf(request), {
          state,
          ...(code === undefined ? {} : { code }),
          ...(iss === undefined ? {} : { iss }),
          ...(error === undefined ? {} : { error }),
        });
        return result.ok
          ? reply.code(202).send(result.value satisfies ConnectorCallbackResponse)
          : sendAppError(reply, result.error);
      });

      v1.delete<{ Params: { connectorId: string } }>(
        "/connections/:connectorId",
        async (request, reply) => {
          if (deps.connections === undefined) return notFoundConnector(reply);
          const result = await deps.connections.disconnect(
            principalOf(request),
            request.params.connectorId,
          );
          return result.ok ? reply.code(202).send() : sendAppError(reply, result.error);
        },
      );

      v1.get("/admin/connections", async (request, reply) => {
        if (deps.connections === undefined) {
          return reply.send({ items: [] } satisfies MemberConnectionListDto);
        }
        const result = await deps.connections.listAll(principalOf(request));
        return result.ok
          ? reply.send({
              items: result.value.map((c) => ({ ...toConnectionDto(c), userId: c.userId })),
            } satisfies MemberConnectionListDto)
          : sendAppError(reply, result.error);
      });

      v1.delete<{ Params: { userId: string; connectorId: string } }>(
        "/admin/connections/:userId/:connectorId",
        async (request, reply) => {
          if (deps.connections === undefined) return notFoundConnector(reply);
          const userId = parseId("UserId", request.params.userId);
          if (!userId.ok) return notFoundConnector(reply);
          const result = await deps.connections.disconnectMember(
            principalOf(request),
            userId.value,
            request.params.connectorId,
          );
          return result.ok ? reply.code(202).send() : sendAppError(reply, result.error);
        },
      );

      v1.post<{ Params: { id: string; approvalId: string } }>(
        "/threads/:id/tool-approvals/:approvalId",
        async (request, reply) => {
          const id = parseId("ThreadId", request.params.id);
          if (deps.toolApprovals === undefined || !id.ok || !UUID.test(request.params.approvalId)) {
            return sendAppError(reply, { kind: "NotFound", resource: "tool approval" });
          }
          const body = DecideToolApprovalRequest.safeParse(request.body);
          if (!body.success) return send(reply, 400, "invalid_request", body.error.message);
          const result = await deps.toolApprovals.decide(
            principalOf(request),
            id.value,
            request.params.approvalId,
            body.data.decision,
          );
          return result.ok
            ? reply.send(result.value satisfies DecideToolApprovalResponse)
            : sendAppError(reply, result.error);
        },
      );

      // Names to share a thread with; anyone who may read threads may see who is in the tenant.
      v1.get("/people", async (request, reply) => {
        const result = await deps.people.list(principalOf(request));
        return result.ok
          ? reply.send({ items: [...result.value] } satisfies PersonListDto)
          : sendAppError(reply, result.error);
      });

      v1.get<{ Params: { id: string } }>("/threads/:id", async (request, reply) => {
        const id = parseId("ThreadId", request.params.id);
        if (!id.ok) return notFoundThread(reply);
        const result = await deps.threads.get(principalOf(request), id.value);
        return result.ok
          ? reply.send(toThreadDto(result.value))
          : sendAppError(reply, result.error);
      });

      v1.put<{ Params: { id: string } }>("/threads/:id/visibility", async (request, reply) => {
        const id = parseId("ThreadId", request.params.id);
        if (!id.ok) return notFoundThread(reply);
        const body = ShareThreadRequest.safeParse(request.body);
        if (!body.success) return send(reply, 400, "invalid_request", body.error.message);
        let memberIds: UserId[] = [];
        if (body.data.kind === "members") {
          for (const raw of body.data.memberIds) {
            const userId = parseId("UserId", raw);
            if (!userId.ok) return send(reply, 400, "invalid_request", "memberIds is invalid");
            memberIds = [...memberIds, userId.value];
          }
        }
        const result = await deps.threads.share(
          principalOf(request),
          id.value,
          body.data.kind === "members" ? { kind: "members", memberIds } : { kind: body.data.kind },
        );
        return result.ok
          ? reply.send(toThreadDto(result.value))
          : sendAppError(reply, result.error);
      });

      v1.post<{ Params: { id: string } }>("/threads/:id/messages", async (request, reply) => {
        const id = parseId("ThreadId", request.params.id);
        if (!id.ok) return notFoundThread(reply);
        const body = PostMessageRequest.safeParse(request.body);
        if (!body.success) return send(reply, 400, "invalid_request", body.error.message);
        const result = await deps.threads.postMessage(principalOf(request), id.value, {
          content: body.data.content,
          ...(body.data.effort === undefined ? {} : { effort: body.data.effort }),
        });
        return result.ok
          ? reply.code(201).send(toMessageDto(result.value))
          : sendAppError(reply, result.error);
      });

      v1.get<{ Params: { id: string } }>("/threads/:id/messages", async (request, reply) => {
        const id = parseId("ThreadId", request.params.id);
        if (!id.ok) return notFoundThread(reply);
        const query = ListMessagesQuery.safeParse(request.query);
        if (!query.success) return send(reply, 400, "invalid_request", query.error.message);
        const result = await deps.threads.listMessages(principalOf(request), id.value, {
          ...(query.data.limit === undefined ? {} : { limit: query.data.limit }),
        });
        return result.ok
          ? reply.send({ items: result.value.map(toMessageDto) } satisfies MessageListDto)
          : sendAppError(reply, result.error);
      });

      // The thread's stream, read like mission events: pass the last seq seen as `after`.
      v1.get<{ Params: { id: string } }>("/threads/:id/events", async (request, reply) => {
        const id = parseId("ThreadId", request.params.id);
        if (!id.ok) return notFoundThread(reply);
        const query = ListEventsQuery.safeParse(request.query);
        if (!query.success) return send(reply, 400, "invalid_request", query.error.message);
        const result = await deps.threads.listEvents(principalOf(request), id.value, {
          ...(query.data.after === undefined ? {} : { afterSeq: query.data.after }),
          ...(query.data.limit === undefined ? {} : { limit: query.data.limit }),
        });
        if (!result.ok) return sendAppError(reply, result.error);
        const items = result.value.map((event) => ({
          seq: event.seq,
          type: event.type,
          payload: event.payload,
          actor: event.actor,
          occurredAt: event.occurredAt.toISOString(),
        }));
        return reply.send({ items } satisfies ThreadEventListDto);
      });

      done();
    },
    { prefix: "/v1" },
  );

  // Unauthenticated: these exchange a password or a refresh token for tokens. Validation errors
  // never echo the request, which carries the password.
  const auth = deps.auth;
  if (auth !== undefined) {
    void app.register(
      (routes, _opts, done) => {
        routes.addHook("onSend", (_request, reply, payload, next) => {
          reply.header("cache-control", "no-store");
          next(null, payload);
        });

        const methods = deps.authMethods ?? { password: true };

        routes.get("/methods", (_request, reply) =>
          reply.send({
            password: methods.password,
            oidc: methods.oidc === undefined ? null : { name: methods.oidc.name },
          } satisfies AuthMethodsDto),
        );

        routes.post("/oidc/start", async (request, reply) => {
          const start = await auth.oidcStart().catch((error: unknown) => {
            request.log.error(error, "OIDC discovery failed");
            return null;
          });
          if (start === undefined) return send(reply, 404, "not_found", "OIDC login is off");
          if (start === null)
            return send(reply, 502, "internal", "the identity provider is unreachable");
          return reply.send(start satisfies OidcStartDto);
        });

        routes.post("/oidc/callback", async (request, reply) => {
          const redirectUri = deps.oidcRedirectUri;
          if (redirectUri === undefined) return send(reply, 404, "not_found", "OIDC login is off");
          const body = OidcCallbackRequest.safeParse(request.body);
          if (!body.success) return send(reply, 400, "invalid_request", "invalid OIDC callback");
          const callback = new URL(redirectUri);
          callback.search = body.data.query.replace(/^\?/, "");
          const result = await auth.oidcFinish(callback, body.data);
          return result.ok
            ? sendTokens(reply, result.value)
            : send(reply, 401, "unauthorized", "the identity provider did not log you in");
        });

        routes.post("/login", async (request, reply) => {
          if (!methods.password) return send(reply, 404, "not_found", "password login is off");
          const body = LoginRequest.safeParse(request.body);
          if (!body.success)
            return send(reply, 400, "invalid_request", "email and password are required");
          const result = await auth.login(body.data.email, body.data.password);
          return result.ok
            ? sendTokens(reply, result.value)
            : send(reply, 401, "unauthorized", "email or password is not correct");
        });

        routes.post("/refresh", async (request, reply) => {
          const body = RefreshRequest.safeParse(request.body);
          if (!body.success) return send(reply, 400, "invalid_request", "refreshToken is required");
          const result = await auth.refresh(body.data.refreshToken);
          return result.ok
            ? sendTokens(reply, result.value)
            : send(reply, 401, "unauthorized", "the session has ended; log in again");
        });

        routes.post("/logout", async (request, reply) => {
          const body = LogoutRequest.safeParse(request.body);
          if (!body.success) return send(reply, 400, "invalid_request", "refreshToken is required");
          await auth.logout(body.data.refreshToken);
          return reply.code(204).send();
        });

        done();
      },
      { prefix: "/v1/auth" },
    );
  }

  return app;
}
