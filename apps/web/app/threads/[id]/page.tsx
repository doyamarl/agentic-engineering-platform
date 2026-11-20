import { MessageListDto, PersonListDto, ThreadDto } from "@aep/contracts";
import Link from "next/link";
import { notFound } from "next/navigation";
import { callApi, isUuid } from "../../lib/api";
import { allows, currentUser } from "../../lib/me";
import { postMessage, shareThread } from "../actions";
import { visibilityLabel } from "../visibility";
import { LiveReplies } from "./live-replies";

export const dynamic = "force-dynamic";

const EFFORTS = [
  { value: "low", label: "速さ優先" },
  { value: "medium", label: "標準" },
  { value: "high", label: "じっくり" },
] as const;

export default async function ThreadPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ id: string }>;
  readonly searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const { error } = await searchParams;
  if (!isUuid(id)) notFound();

  // A thread the person may not read answers 404, like one that does not exist (ADR-014).
  const found = await callApi(`/v1/threads/${id}`, {}, ThreadDto);
  if (!found.ok && found.status === 404) notFound();
  if (!found.ok) {
    return (
      <main>
        <p role="alert">スレッドを取得できません: {found.message}</p>
      </main>
    );
  }
  const thread = found.value;
  const [messages, people, me] = await Promise.all([
    callApi(`/v1/threads/${id}/messages?limit=500`, {}, MessageListDto),
    callApi("/v1/people", {}, PersonListDto),
    currentUser(),
  ]);
  const names = new Map(
    people.ok ? people.value.items.map((p) => [p.userId, p.displayName] as const) : [],
  );
  const items = messages.ok ? messages.value.items : [];
  const replied = new Set(items.flatMap((m) => (m.inReplyTo === undefined ? [] : [m.inReplyTo])));
  const awaiting = items.filter((m) => m.role === "user" && !replied.has(m.id)).map((m) => m.id);
  const isOwner = thread.ownerId === me?.userId;
  const chosen = new Set(thread.visibility.kind === "members" ? thread.visibility.memberIds : []);
  const others = people.ok ? people.value.items.filter((p) => p.userId !== me?.userId) : [];

  return (
    <main>
      <p>
        <Link href="/threads">← スレッド</Link>
      </p>
      <h1>{thread.title}</h1>
      <p className="muted">
        公開範囲: {visibilityLabel(thread.visibility)} / 持ち主:{" "}
        {isOwner ? "自分" : (names.get(thread.ownerId) ?? "-")}
      </p>
      {error === undefined ? null : <p role="alert">操作できません: {error}</p>}

      <section aria-label="会話" className="messages">
        {!messages.ok ? (
          <p role="alert">メッセージを取得できません: {messages.message}</p>
        ) : items.length === 0 ? (
          <p className="muted">まだメッセージはありません。</p>
        ) : (
          items.map((m) => (
            <article key={m.id} className={`message ${m.role}`}>
              <p className="who">
                {m.role === "assistant"
                  ? `モデル${m.model === undefined ? "" : `（${m.model}）`}`
                  : m.authorId === me?.userId
                    ? "自分"
                    : (names.get(m.authorId ?? "") ?? "メンバー")}
                <time className="muted" dateTime={m.createdAt}>
                  {" "}
                  {new Date(m.createdAt).toLocaleString("ja-JP")}
                </time>
              </p>
              <div className="content">{m.content}</div>
            </article>
          ))
        )}
        <LiveReplies
          threadId={thread.id}
          shownMessageIds={items.map((m) => m.id)}
          awaiting={awaiting}
          viewerId={me?.userId ?? ""}
          names={Object.fromEntries(names)}
        />
      </section>

      {allows(me, "thread:write") ? (
        <form action={postMessage} className="stack">
          <input type="hidden" name="threadId" value={thread.id} />
          <label>
            メッセージ
            <textarea name="content" required maxLength={32000} rows={4} />
          </label>
          <label>
            返答の深さ
            <select name="effort" defaultValue="low">
              {EFFORTS.map((e) => (
                <option key={e.value} value={e.value}>
                  {e.label}
                </option>
              ))}
            </select>
          </label>
          <button type="submit">送信する</button>
        </form>
      ) : null}

      {isOwner && allows(me, "thread:write") ? (
        <form action={shareThread} className="stack">
          <input type="hidden" name="threadId" value={thread.id} />
          <fieldset>
            <legend>公開範囲</legend>
            <label className="choice">
              <input
                type="radio"
                name="kind"
                value="personal"
                defaultChecked={thread.visibility.kind === "personal"}
              />
              個人（自分だけ）
            </label>
            <label className="choice">
              <input
                type="radio"
                name="kind"
                value="members"
                defaultChecked={thread.visibility.kind === "members"}
              />
              選んだメンバー
            </label>
            {others.map((p) => (
              <label key={p.userId} className="choice indent">
                <input
                  type="checkbox"
                  name="memberIds"
                  value={p.userId}
                  defaultChecked={chosen.has(p.userId)}
                />
                {p.displayName}
              </label>
            ))}
            <label className="choice">
              <input
                type="radio"
                name="kind"
                value="workspace"
                defaultChecked={thread.visibility.kind === "workspace"}
              />
              ワークスペース全体
            </label>
          </fieldset>
          <button type="submit">公開範囲を変える</button>
        </form>
      ) : null}
    </main>
  );
}
