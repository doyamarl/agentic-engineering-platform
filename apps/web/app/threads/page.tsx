import { PersonListDto, ThreadListDto, WorkspaceListDto } from "@aep/contracts";
import Link from "next/link";
import { callApi } from "../lib/api";
import { allows, currentUser } from "../lib/me";
import { createThread } from "./actions";
import { visibilityLabel } from "./visibility";

export const dynamic = "force-dynamic";

export default async function ThreadsPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const [threads, workspaces, people, me] = await Promise.all([
    callApi("/v1/threads?limit=100", {}, ThreadListDto),
    callApi("/v1/workspaces", {}, WorkspaceListDto),
    callApi("/v1/people", {}, PersonListDto),
    currentUser(),
  ]);
  const names = new Map(
    people.ok ? people.value.items.map((p) => [p.userId, p.displayName] as const) : [],
  );
  return (
    <main>
      <h1>スレッド</h1>
      {error === undefined ? null : <p role="alert">作成できません: {error}</p>}
      {allows(me, "thread:write") ? (
        <form action={createThread} className="stack">
          <h2>新しいスレッド</h2>
          <label>
            タイトル
            <input name="title" required maxLength={200} />
          </label>
          {!workspaces.ok ? (
            <p role="alert">Workspace の一覧を取得できません: {workspaces.message}</p>
          ) : workspaces.value.items.length === 0 ? (
            <p role="alert">Workspace がありません。管理者に作成を依頼してください。</p>
          ) : (
            <label>
              Workspace
              <select name="workspaceId" required>
                {workspaces.value.items.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="muted">作ったスレッドは、共有するまで自分だけが読めます。</p>
          <button type="submit">スレッドを作る</button>
        </form>
      ) : null}
      <h2>読めるスレッド</h2>
      {!threads.ok ? (
        <p role="alert">一覧を取得できません: {threads.message}</p>
      ) : threads.value.items.length === 0 ? (
        <p>スレッドはまだありません。</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>タイトル</th>
              <th>公開範囲</th>
              <th>持ち主</th>
              <th>作成</th>
            </tr>
          </thead>
          <tbody>
            {threads.value.items.map((t) => (
              <tr key={t.id}>
                <td>
                  <Link href={`/threads/${t.id}`}>{t.title}</Link>
                </td>
                <td>{visibilityLabel(t.visibility)}</td>
                <td>{t.ownerId === me?.userId ? "自分" : (names.get(t.ownerId) ?? "-")}</td>
                <td>{new Date(t.createdAt).toLocaleString("ja-JP")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
