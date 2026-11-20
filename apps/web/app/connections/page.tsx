import { ConnectorListDto, type ConnectorDto } from "@aep/contracts";
import { notFound } from "next/navigation";
import { callApi } from "../lib/api";
import { allows, currentUser } from "../lib/me";
import { connect, disconnect } from "./actions";
import { RefreshWhilePending } from "./refresh-while-pending";
import { ConnectionBadge, PENDING } from "./status";

export const dynamic = "force-dynamic";

// Each person connects outside tools with their own account (ADR-013). The tokens stay with the
// worker; this page only sees each connection's status.

function ConnectForm({ connector, label }: { readonly connector: ConnectorDto; label: string }) {
  return (
    <form action={connect} className="inline">
      <input type="hidden" name="connectorId" value={connector.id} />
      {connector.servers.length > 1 ? (
        <select name="serverId" aria-label={`${connector.name} のリージョン`}>
          {connector.servers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      ) : null}
      <button type="submit" aria-label={`${connector.name} に${label}`}>
        {label}
      </button>
    </form>
  );
}

function DisconnectForm({ connector }: { readonly connector: ConnectorDto }) {
  return (
    <form action={disconnect} className="inline">
      <input type="hidden" name="connectorId" value={connector.id} />
      <button type="submit" className="danger" aria-label={`${connector.name} から切断する`}>
        切断する
      </button>
    </form>
  );
}

function Connector({ connector }: { readonly connector: ConnectorDto }) {
  const connection = connector.connection;
  const server = connector.servers.find((s) => s.id === connection?.serverId);
  const reads = connector.tools.filter((t) => t.class === "read").map((t) => t.name);
  const writes = connector.tools.filter((t) => t.class === "write").map((t) => t.name);
  return (
    <section aria-label={connector.name}>
      <h2>{connector.name}</h2>
      <p>{connector.description}</p>
      <p>
        {connection === undefined ? (
          <span className="badge">未接続</span>
        ) : (
          <ConnectionBadge status={connection.status} />
        )}
        {server === undefined || connector.servers.length < 2 ? null : (
          <span className="muted"> {server.label}</span>
        )}
        {connection?.status === "failed" && connection.error !== undefined ? (
          <span className="reason"> 理由: {connection.error}</span>
        ) : null}
      </p>
      <div className="actions">
        {connection === undefined || connection.status === "failed" ? (
          <ConnectForm connector={connector} label="接続する" />
        ) : null}
        {connection?.status === "expired" ? (
          <ConnectForm connector={connector} label="接続し直す" />
        ) : null}
        {connection?.status === "connected" || connection?.status === "expired" ? (
          <DisconnectForm connector={connector} />
        ) : null}
      </div>
      <p className="muted">
        読み取り: {reads.length === 0 ? "なし" : reads.join(", ")}
        <br />
        書き込み（呼ぶたびに承認が要ります）: {writes.length === 0 ? "なし" : writes.join(", ")}
      </p>
    </section>
  );
}

export default async function ConnectionsPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ error?: string }>;
}) {
  const me = await currentUser();
  if (!allows(me, "connector:use")) notFound();
  const { error } = await searchParams;
  const result = await callApi("/v1/connectors", {}, ConnectorListDto);
  const pending =
    result.ok &&
    result.value.items.some(
      (c) => c.connection !== undefined && PENDING.includes(c.connection.status),
    );

  return (
    <main>
      <h1>接続</h1>
      <p className="muted">
        自分のアカウントで外部のツールに接続すると、自分のスレッドでモデルがそのツールを読めるようになります。
        トークンは暗号化して保管し、ほかのメンバーや管理者には見えません。
      </p>
      {error === undefined ? null : <p role="alert">接続できません: {error}</p>}
      <RefreshWhilePending pending={pending} />
      {!result.ok ? (
        <p role="alert">一覧を取得できません: {result.message}</p>
      ) : result.value.items.length === 0 ? (
        <p>このインスタンスでは接続できるツールが設定されていません。</p>
      ) : (
        result.value.items.map((connector) => (
          <Connector key={connector.id} connector={connector} />
        ))
      )}
    </main>
  );
}
