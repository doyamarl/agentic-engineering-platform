import { ConnectorListDto, MemberConnectionListDto, MemberListDto } from "@aep/contracts";
import { notFound } from "next/navigation";
import { callApi } from "../../lib/api";
import { allows, currentUser } from "../../lib/me";
import { RefreshWhilePending } from "../../connections/refresh-while-pending";
import { ConnectionBadge, PENDING } from "../../connections/status";
import { disconnectMember } from "./actions";

export const dynamic = "force-dynamic";

// Who is connected to what (permission connector:manage). Status only: no admin sees a token.
// Disconnecting a member revokes their tokens at the provider, as their own disconnect would.

export default async function AdminConnectionsPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ error?: string }>;
}) {
  const me = await currentUser();
  if (!allows(me, "connector:manage")) notFound();
  const { error } = await searchParams;
  const [connections, members, connectors] = await Promise.all([
    callApi("/v1/admin/connections", {}, MemberConnectionListDto),
    callApi("/v1/members", {}, MemberListDto),
    callApi("/v1/connectors", {}, ConnectorListDto),
  ]);
  const nameOf = (userId: string) =>
    (members.ok ? members.value.items.find((m) => m.userId === userId)?.displayName : undefined) ??
    userId;
  const connectorName = (id: string) =>
    (connectors.ok ? connectors.value.items.find((c) => c.id === id)?.name : undefined) ?? id;

  return (
    <main>
      <h1>メンバーの接続</h1>
      <p className="muted">
        誰がどのツールに接続しているかを表示します。トークンは管理者にも見えません。切断すると、接続先でもトークンを取り消します。
      </p>
      {error === undefined ? null : <p role="alert">切断できませんでした: {error}</p>}
      {!connections.ok ? (
        <p role="alert">一覧を取得できません: {connections.message}</p>
      ) : connections.value.items.length === 0 ? (
        <p>接続しているメンバーはいません。</p>
      ) : (
        <>
          <RefreshWhilePending
            pending={connections.value.items.some((c) => PENDING.includes(c.status))}
          />
          <table>
            <thead>
              <tr>
                <th>メンバー</th>
                <th>ツール</th>
                <th>状態</th>
                <th>接続した日時</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {connections.value.items.map((c) => (
                <tr key={`${c.userId}:${c.connectorId}`}>
                  <td>{nameOf(c.userId)}</td>
                  <td>{connectorName(c.connectorId)}</td>
                  <td>
                    <ConnectionBadge status={c.status} />
                  </td>
                  <td>{c.connectedAt ?? "-"}</td>
                  <td>
                    {c.status === "disconnecting" ? null : (
                      <form action={disconnectMember} className="inline">
                        <input type="hidden" name="userId" value={c.userId} />
                        <input type="hidden" name="connectorId" value={c.connectorId} />
                        <button
                          type="submit"
                          className="danger"
                          aria-label={`${nameOf(c.userId)} の ${connectorName(c.connectorId)} を切断する`}
                        >
                          切断する
                        </button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </main>
  );
}
