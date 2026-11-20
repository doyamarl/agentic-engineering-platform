const LABELS: Readonly<Record<string, string>> = {
  DRAFT: "下書き",
  PLANNING: "計画中",
  AWAITING_PLAN_APPROVAL: "計画の承認待ち",
  APPROVED: "承認済み",
  EXECUTING: "実行中",
  VERIFYING: "検証中",
  ACCEPTANCE_READY: "受け入れ待ち",
  AWAITING_RELEASE_APPROVAL: "リリース承認待ち",
  COMPLETED: "完了",
  FAILED: "失敗",
  BLOCKED: "ブロック",
  CANCEL_REQUESTED: "キャンセル中",
  CANCELLED: "キャンセル済み",
};

export function StatusBadge({ status }: { readonly status: string }) {
  return (
    <span className={`badge badge-${status.toLowerCase()}`} title={status}>
      {LABELS[status] ?? status}
    </span>
  );
}
