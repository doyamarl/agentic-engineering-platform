import { MissionListDto } from "@aep/contracts";
import Link from "next/link";
import { callApi } from "../lib/api";
import { allows, currentUser } from "../lib/me";
import { StatusBadge } from "./status-badge";

export const dynamic = "force-dynamic";

export default async function MissionsPage() {
  const [result, me] = await Promise.all([
    callApi("/v1/missions?limit=100", {}, MissionListDto),
    currentUser(),
  ]);
  return (
    <main>
      <h1>ミッション</h1>
      {allows(me, "mission:create") ? (
        <p>
          <Link href="/missions/new">新しいミッション</Link>
        </p>
      ) : null}
      {!result.ok ? (
        <p role="alert">一覧を取得できません: {result.message}</p>
      ) : result.value.items.length === 0 ? (
        <p>ミッションはまだありません。</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>タイトル</th>
              <th>状態</th>
              <th>Issue</th>
              <th>作成</th>
            </tr>
          </thead>
          <tbody>
            {result.value.items.map((m) => (
              <tr key={m.id}>
                <td>
                  <Link href={`/missions/${m.id}`}>{m.title}</Link>
                </td>
                <td>
                  <StatusBadge status={m.status} />
                </td>
                <td>
                  {m.source === undefined
                    ? "-"
                    : `${m.source.owner}/${m.source.repo}#${String(m.source.issueNumber)}`}
                </td>
                <td>{new Date(m.createdAt).toLocaleString("ja-JP")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
