import type { ConnectionStatus } from "@aep/contracts";

const LABELS: Readonly<Record<ConnectionStatus, string>> = {
  connecting: "接続中",
  failed: "接続できませんでした",
  connected: "接続済み",
  expired: "期限切れ",
  disconnecting: "切断中",
};

/** Statuses the worker is still working on; the page reloads until they settle. */
export const PENDING: readonly ConnectionStatus[] = ["connecting", "disconnecting"];

export function ConnectionBadge({ status }: { readonly status: ConnectionStatus }) {
  const tone =
    status === "connected"
      ? "completed"
      : status === "failed" || status === "expired"
        ? "failed"
        : "";
  return (
    <span className={`badge badge-${tone}`} title={status}>
      {LABELS[status]}
    </span>
  );
}
