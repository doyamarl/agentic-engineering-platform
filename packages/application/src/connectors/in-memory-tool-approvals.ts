import { err, ok, type MessageId, type ThreadId } from "@aep/domain";
import type { NewJob } from "../jobs/job-queue.ts";
import type { AuditEventInput } from "../members/member-ports.ts";
import type { InMemoryThreads } from "../threads/in-memory-threads.ts";
import type { ThreadScope } from "../threads/thread-ports.ts";
import type { ReplyPause, ToolApproval, ToolApprovalRepository } from "./tool-approval-ports.ts";

/** For tests: pauses kept in memory, events and jobs written to an InMemoryThreads. */
export class InMemoryToolApprovals implements ToolApprovalRepository {
  readonly pauses = new Map<string, ReplyPause & { readonly tenantId: string }>();
  readonly audit: AuditEventInput[] = [];
  readonly #threads: InMemoryThreads;

  constructor(threads: InMemoryThreads) {
    this.#threads = threads;
  }

  #own(scope: ThreadScope, pauseId: string) {
    const pause = this.pauses.get(pauseId);
    return pause?.tenantId === scope.tenantId && pause.requestedBy === scope.userId
      ? pause
      : undefined;
  }

  #update(pauseId: string, approvalId: string, change: Partial<ToolApproval>) {
    const pause = this.pauses.get(pauseId);
    if (pause === undefined) return;
    this.pauses.set(pauseId, {
      ...pause,
      approvals: pause.approvals.map((a) => (a.id === approvalId ? { ...a, ...change } : a)),
    });
  }

  async pause(
    scope: ThreadScope,
    pause: Omit<ReplyPause, "closed">,
    events: Parameters<ToolApprovalRepository["pause"]>[2],
    at: Date,
    expiry?: NewJob,
  ) {
    for (const event of events) {
      const appended = await this.#threads.appendEvent(scope, pause.threadId, event, at);
      if (!appended.ok) return appended;
    }
    this.pauses.set(pause.id, { ...pause, closed: false, tenantId: scope.tenantId });
    if (expiry !== undefined) this.#threads.enqueued.push(expiry);
    return ok(undefined);
  }

  async expire(
    scope: ThreadScope,
    pauseId: string,
    at: Date,
    effects: Parameters<ToolApprovalRepository["decide"]>[5],
  ) {
    const pause = this.#own(scope, pauseId);
    if (pause === undefined || pause.closed) return { expired: 0 };
    const pending = pause.approvals.filter((a) => a.status === "pending");
    for (const approval of pending) {
      const expired: ToolApproval = { ...approval, status: "expired" };
      await this.#threads.appendEvent(scope, pause.threadId, effects.event(expired), at);
      this.#update(pauseId, approval.id, { status: "expired" });
      this.audit.push(effects.audit(expired));
    }
    if (pending.length > 0) {
      this.#threads.enqueued.push(
        effects.continuation({
          id: pause.id,
          threadId: pause.threadId,
          messageId: pause.messageId,
          requestedBy: pause.requestedBy,
          closed: false,
        }),
      );
    }
    return { expired: pending.length };
  }

  async decide(
    scope: ThreadScope,
    threadId: ThreadId,
    approvalId: string,
    decision: "approve" | "reject",
    at: Date,
    effects: Parameters<ToolApprovalRepository["decide"]>[5],
  ) {
    const pause = [...this.pauses.values()].find(
      (p) => p.threadId === threadId && p.approvals.some((a) => a.id === approvalId),
    );
    if (pause === undefined || this.#own(scope, pause.id) === undefined) {
      return err({ kind: "NotFound" } as const);
    }
    const approval = pause.approvals.find((a) => a.id === approvalId);
    if (approval?.status !== "pending" || pause.closed) return err({ kind: "Conflict" } as const);
    const decided: ToolApproval = {
      ...approval,
      status: decision === "approve" ? "approved" : "rejected",
    };
    const appended = await this.#threads.appendEvent(scope, threadId, effects.event(decided), at);
    if (!appended.ok) return appended;
    this.#update(pause.id, approvalId, { status: decided.status });
    this.audit.push(effects.audit(decided));
    const complete = (this.pauses.get(pause.id)?.approvals ?? []).every(
      (a) => a.status !== "pending",
    );
    if (complete) {
      this.#threads.enqueued.push(
        effects.continuation({
          id: pause.id,
          threadId: pause.threadId,
          messageId: pause.messageId,
          requestedBy: pause.requestedBy,
          closed: false,
        }),
      );
    }
    return ok({ complete });
  }

  findPause(scope: ThreadScope, pauseId: string) {
    const pause = this.#own(scope, pauseId);
    if (pause === undefined) return Promise.resolve(undefined);
    const { tenantId: _tenantId, ...rest } = pause;
    return Promise.resolve(rest);
  }

  hasOpenPause(scope: ThreadScope, threadId: ThreadId, messageId: MessageId) {
    return Promise.resolve(
      [...this.pauses.values()].some(
        (p) =>
          this.#own(scope, p.id) !== undefined &&
          p.threadId === threadId &&
          p.messageId === messageId &&
          !p.closed,
      ),
    );
  }

  claim(
    scope: ThreadScope,
    approvalId: string,
    call: { readonly connectorId: string; readonly tool: string; readonly input: unknown },
  ) {
    for (const pause of this.pauses.values()) {
      if (this.#own(scope, pause.id) === undefined) continue;
      const approval = pause.approvals.find((a) => a.id === approvalId);
      if (approval === undefined) continue;
      const matches =
        approval.status === "approved" &&
        approval.connectorId === call.connectorId &&
        approval.tool === call.tool &&
        JSON.stringify(approval.input) === JSON.stringify(call.input);
      if (matches) this.#update(pause.id, approvalId, { status: "executing" });
      return Promise.resolve(matches);
    }
    return Promise.resolve(false);
  }

  finish(scope: ThreadScope, approvalId: string, _at?: Date) {
    for (const pause of this.pauses.values()) {
      if (this.#own(scope, pause.id) === undefined) continue;
      if (pause.approvals.some((a) => a.id === approvalId && a.status === "executing")) {
        this.#update(pause.id, approvalId, { status: "done" });
      }
    }
    return Promise.resolve();
  }

  close(scope: ThreadScope, pauseId: string) {
    const pause = this.#own(scope, pauseId);
    if (pause !== undefined) {
      this.pauses.set(pauseId, {
        ...pause,
        closed: true,
        snapshot: { turns: [], callOrder: [], answered: [], text: "", round: 0, sources: [] },
      });
    }
    return Promise.resolve();
  }
}
