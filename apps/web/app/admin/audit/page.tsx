import { AuditEventListDto, MemberListDto } from "@aep/contracts";
import Link from "next/link";
import { notFound } from "next/navigation";
import { callApi } from "../../lib/api";
import { allows, currentUser } from "../../lib/me";

export const dynamic = "force-dynamic";

const PAGE = 100;

const LABELS: Record<string, string> = {
  "member.created": "メンバーの登録",
  "member.role_changed": "ロールの変更",
  "member.disabled": "無効化",
  "member.enabled": "有効化",
  "member.password_reset": "パスワードの再発行",
  "login.succeeded": "ログイン",
  "login.failed": "ログインの失敗",
  "password.changed": "パスワードの変更",
  "settings.chat_model_changed": "返答のモデルの変更",
};

export default async function AuditPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ after?: string }>;
}) {
  const me = await currentUser();
  if (!allows(me, "member:manage")) notFound();
  const { after } = await searchParams;
  const from = after !== undefined && /^[0-9]{1,15}$/.test(after) ? after : "0";
  const [events, members] = await Promise.all([
    callApi(`/v1/audit-events?after=${from}&limit=${String(PAGE)}`, {}, AuditEventListDto),
    callApi("/v1/members", {}, MemberListDto),
  ]);
  const names = new Map(
    (members.ok ? members.value.items : []).map((m) => [m.userId, m.displayName]),
  );
  const who = (id: string | null) => (id === null ? "-" : (names.get(id) ?? id));

  return (
    <main>
      <p>
        <Link href="/admin/members">← メンバー</Link>
      </p>
      <h1>監査ログ</h1>
      {!events.ok ? (
        <p role="alert">取得できません: {events.message}</p>
      ) : events.value.items.length === 0 ? (
        <p>記録はありません。</p>
      ) : (
        <>
          <table>
            <thead>
              <tr>
                <th>日時</th>
                <th>出来事</th>
                <th>操作した人</th>
                <th>対象</th>
                <th>詳細</th>
              </tr>
            </thead>
            <tbody>
              {events.value.items.map((event) => (
                <tr key={event.id}>
                  <td>{new Date(event.occurredAt).toLocaleString("ja-JP")}</td>
                  <td>{LABELS[event.type] ?? event.type}</td>
                  <td>{who(event.actorId)}</td>
                  <td>{who(event.subjectId)}</td>
                  <td className="muted">
                    {Object.entries(event.payload)
                      .map(([key, value]) => `${key}: ${String(value)}`)
                      .join(", ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {events.value.items.length === PAGE ? (
            <p>
              <Link href={`/admin/audit?after=${String(events.value.items.at(-1)?.id ?? 0)}`}>
                次の {PAGE} 件
              </Link>
            </p>
          ) : null}
        </>
      )}
    </main>
  );
}
