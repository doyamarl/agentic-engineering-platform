"use client";

import type { ThreadEventDto } from "@aep/contracts";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { decideToolApproval } from "../actions";

// Replies being written, built from the thread's events (ADR-012): `reply.started` begins an
// attempt (dropping the text of an earlier one), `reply.delta` adds text, `reply.failed` ends it,
// and `message.created` means a message was stored, so the page is read again to show it.
// Connector tool calls (ADR-013) show as notes under the reply being written: which tool of which
// connector, through whose connection (or, for the workspace's code, the GitHub App), and how the
// call ended. Their results are not events.
// A write tool pauses the reply (`tool.approval_requested`): a card shows the exact arguments, and
// only the person whose connection it would use gets the buttons; the API checks that again.
// Polling, like the mission event log; server-sent events can replace it if typing feels slow.

const POLL_MS = 1000;
const PAGE = 500;

type Approval = {
  readonly approvalId: string;
  readonly connectorId: string;
  readonly tool: string;
  readonly input: string;
  /** The person whose connection the call would use; only they decide. */
  readonly userId: string;
  /** ISO time after which the call expires undecided. */
  readonly expiresAt: string;
  readonly decision?: "approve" | "reject" | "expired";
};

type Reply =
  | {
      readonly status: "writing";
      readonly text: string;
      readonly notes: readonly string[];
      readonly approvals: readonly Approval[];
    }
  | { readonly status: "failed"; readonly reason: string };

const FAILURES: Readonly<Record<string, string>> = {
  refused: "モデルがこの依頼を断りました。",
  empty: "モデルが何も返しませんでした。",
  model_error: "モデルの呼び出しが拒まれました。",
  gave_up: "何度か試しましたが返答できませんでした。",
  tool_limit: "ツールの呼び出しが上限に達し、返答をまとめられませんでした。",
};

const OUTCOMES: Readonly<Record<string, string>> = {
  ok: "完了しました",
  rejected: "却下されたので実行しませんでした",
  unknown: "承認されましたが、実行されたか分かりません（再実行はしません）",
  approval_expired: "期限までに承認されなかったので実行しませんでした",
  tool_error: "ツールがエラーを返しました",
  refused: "許可されていないので呼びませんでした",
  not_connected: "接続されていません",
  expired: "接続の期限が切れています。接続し直してください",
  timeout: "時間内に答えがありませんでした",
  failed: "呼び出しに失敗しました",
};

const text = (payload: ThreadEventDto["payload"], key: string): string => {
  const value = payload[key];
  return typeof value === "string" ? value : "";
};

/** A note about a connector event, or undefined for other events. */
function noteOf(event: ThreadEventDto): string | undefined {
  const p = event.payload;
  switch (event.type) {
    case "tool.called":
      // Code tools read through the instance's GitHub App, not the person's connection (#52).
      return text(p, "via") === "github_app"
        ? `${text(p, "repository")} を ${text(p, "tool")} で読んでいます（ワークスペースの GitHub App）`
        : `${text(p, "connectorId")} の ${text(p, "tool")} を呼んでいます（質問した人の接続）`;
    case "tool.finished": {
      const outcome = OUTCOMES[text(p, "outcome")] ?? text(p, "outcome");
      const cut = p["truncated"] === true ? "（長いので途中まで）" : "";
      return `${text(p, "connectorId")} の ${text(p, "tool")}: ${outcome}${cut}`;
    }
    case "connector.unavailable":
      return text(p, "reason") === "expired"
        ? `${text(p, "connectorId")} の接続は期限切れです。接続し直してください`
        : `${text(p, "connectorId")} に接続できませんでした`;
    case "reply.limited":
      return `ツールの呼び出しが上限（${String(p["limit"])} 回）に達したので、ここまでで返答します`;
    default:
      return undefined;
  }
}

function apply(
  replies: ReadonlyMap<string, Reply>,
  event: ThreadEventDto,
): ReadonlyMap<string, Reply> {
  const replyTo = event.payload["replyTo"];
  if (typeof replyTo !== "string") return replies;
  const next = new Map(replies);
  const current = next.get(replyTo);
  switch (event.type) {
    case "reply.started":
      next.set(replyTo, { status: "writing", text: "", notes: [], approvals: [] });
      break;
    case "reply.delta": {
      const piece = event.payload["text"];
      if (current?.status === "writing" && typeof piece === "string") {
        next.set(replyTo, { ...current, text: current.text + piece });
      }
      break;
    }
    case "tool.called":
    case "tool.finished":
    case "connector.unavailable":
    case "reply.limited": {
      const note = noteOf(event);
      if (current?.status === "writing" && note !== undefined) {
        next.set(replyTo, { ...current, notes: [...current.notes, note] });
      }
      break;
    }
    case "tool.approval_requested": {
      const p = event.payload;
      if (current?.status === "writing") {
        const approval: Approval = {
          approvalId: text(p, "approvalId"),
          connectorId: text(p, "connectorId"),
          tool: text(p, "tool"),
          input: text(p, "input"),
          userId: text(p, "userId"),
          expiresAt: text(p, "expiresAt"),
        };
        next.set(replyTo, { ...current, approvals: [...current.approvals, approval] });
      }
      break;
    }
    case "tool.approval_decided": {
      const p = event.payload;
      const decision = text(p, "decision");
      if (
        current?.status === "writing" &&
        (decision === "approve" || decision === "reject" || decision === "expired")
      ) {
        next.set(replyTo, {
          ...current,
          approvals: current.approvals.map((a) =>
            a.approvalId === text(p, "approvalId") ? { ...a, decision } : a,
          ),
        });
      }
      break;
    }
    case "reply.failed": {
      const reason = event.payload["reason"];
      next.set(replyTo, {
        status: "failed",
        reason:
          (typeof reason === "string" ? FAILURES[reason] : undefined) ?? "返答できませんでした。",
      });
      break;
    }
    case "message.created":
      next.delete(replyTo);
      break;
  }
  return next;
}

const DECISIONS: Readonly<Record<NonNullable<Approval["decision"]>, string>> = {
  approve: "承認されました",
  reject: "却下されました",
  expired: "期限切れになりました",
};

/** A deadline in the viewer's locale, or as it came if it does not parse. */
function deadline(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString("ja-JP", { dateStyle: "medium", timeStyle: "short" });
}

/** The arguments as indented JSON, or as they came if they do not parse. */
function pretty(input: string): string {
  try {
    return JSON.stringify(JSON.parse(input), null, 2);
  } catch {
    return input;
  }
}

function ApprovalCard({
  threadId,
  approval,
  viewerId,
  names,
}: {
  readonly threadId: string;
  readonly approval: Approval;
  readonly viewerId: string;
  readonly names: Readonly<Record<string, string>>;
}) {
  const owner = names[approval.userId] ?? "質問した人";
  const label = `${approval.connectorId} の ${approval.tool}`;
  return (
    <section className="approval" aria-label={`${label} の承認`}>
      <p>
        モデルが <strong>{label}</strong> を {owner} の接続で実行しようとしています。
        このツールは接続先のデータを変えることがあります。
      </p>
      <pre className="plan">{pretty(approval.input)}</pre>
      {approval.expiresAt === "" || approval.decision !== undefined ? null : (
        <p className="muted">
          期限: {deadline(approval.expiresAt)}（それまでに決めないと実行しません）
        </p>
      )}
      {approval.decision !== undefined ? (
        <p className="muted">{DECISIONS[approval.decision]}</p>
      ) : approval.userId === viewerId ? (
        <div className="decide">
          {(["approve", "reject"] as const).map((decision) => (
            <form key={decision} action={decideToolApproval}>
              <input type="hidden" name="threadId" value={threadId} />
              <input type="hidden" name="approvalId" value={approval.approvalId} />
              <input type="hidden" name="decision" value={decision} />
              <button type="submit" className={decision === "approve" ? "danger" : undefined}>
                {decision === "approve" ? "この内容で実行する" : "実行しない"}
              </button>
            </form>
          ))}
        </div>
      ) : (
        <p className="muted">{owner} の承認を待っています。</p>
      )}
    </section>
  );
}

export function LiveReplies({
  threadId,
  shownMessageIds,
  awaiting,
  viewerId,
  names,
}: {
  readonly threadId: string;
  /** Messages the page already shows; a stored message not among them reloads the page. */
  readonly shownMessageIds: readonly string[];
  /** People's messages without a stored reply. */
  readonly awaiting: readonly string[];
  /** The signed-in person, who may decide approvals for their own connections. */
  readonly viewerId: string;
  /** Display names by user id. */
  readonly names: Readonly<Record<string, string>>;
}) {
  const router = useRouter();
  const [replies, setReplies] = useState<ReadonlyMap<string, Reply>>(new Map());
  const last = useRef(0);
  const shown = useRef(new Set(shownMessageIds));

  useEffect(() => {
    shown.current = new Set(shownMessageIds);
  }, [shownMessageIds]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      let stale = false;
      try {
        for (;;) {
          const response = await fetch(
            `/threads/${threadId}/events?after=${String(last.current)}`,
            { cache: "no-store" },
          );
          if (!response.ok || stopped) break;
          const body = (await response.json()) as { items: ThreadEventDto[] };
          for (const event of body.items) {
            const messageId = event.payload["messageId"];
            if (
              event.type === "message.created" &&
              typeof messageId === "string" &&
              !shown.current.has(messageId)
            ) {
              stale = true;
            }
          }
          last.current = body.items.at(-1)?.seq ?? last.current;
          setReplies((current) => body.items.reduce(apply, current));
          if (body.items.length < PAGE) break;
        }
      } catch {
        // Try again at the next poll.
      }
      if (stale && !stopped) router.refresh();
      if (!stopped) timer = setTimeout(() => void poll(), POLL_MS);
    };
    void poll();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [threadId, router]);

  // Only messages still without a reply: a failure of a message answered since stays out.
  const current = [...replies].filter(([replyTo]) => awaiting.includes(replyTo));
  const pending = awaiting.filter((id) => !replies.has(id));
  if (current.length === 0 && pending.length === 0) return null;
  return (
    <div aria-live="polite">
      {current.map(([replyTo, reply]) =>
        reply.status === "writing" ? (
          <article key={replyTo} className="message assistant" aria-busy="true">
            <p className="who">モデル（書いています）</p>
            {reply.notes.length === 0 ? null : (
              <ul className="tool-notes">
                {reply.notes.map((note, i) => (
                  <li key={i}>{note}</li>
                ))}
              </ul>
            )}
            <div className="content">{reply.text === "" ? "…" : reply.text}</div>
            {reply.approvals.map((approval) => (
              <ApprovalCard
                key={approval.approvalId}
                threadId={threadId}
                approval={approval}
                viewerId={viewerId}
                names={names}
              />
            ))}
          </article>
        ) : (
          <p key={replyTo} role="alert">
            {reply.reason}
          </p>
        ),
      )}
      {pending.map((id) => (
        <p key={id} className="muted">
          返答を待っています…
        </p>
      ))}
    </div>
  );
}
