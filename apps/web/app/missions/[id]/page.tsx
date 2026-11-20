import {
  AcceptancePacketDto,
  MissionDto,
  MissionEventListDto,
  PlanDto,
  type MissionDto as Mission,
} from "@aep/contracts";
import Link from "next/link";
import { notFound } from "next/navigation";
import { callApi, httpsUrl, isUuid } from "../../lib/api";
import { allows, currentUser } from "../../lib/me";
import { approvePlan, cancelMission, rejectPlan, startPlanning } from "../actions";
import { StatusBadge } from "../status-badge";
import { EventLog } from "./event-log";

export const dynamic = "force-dynamic";

const FINISHED = new Set(["COMPLETED", "CANCELLED", "CANCEL_REQUESTED"]);

/** A link for an https URL from the API; any other URL is shown as text. */
function ExternalLink({ url, children }: { readonly url: string; readonly children: string }) {
  const href = httpsUrl(url);
  return href === undefined ? (
    <span>{children}</span>
  ) : (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  );
}

function Hidden({ mission }: { readonly mission: Mission }) {
  return <input type="hidden" name="missionId" value={mission.id} />;
}

export default async function MissionPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ id: string }>;
  readonly searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const { error } = await searchParams;
  if (!isUuid(id)) notFound();

  const found = await callApi(`/v1/missions/${id}`, {}, MissionDto);
  if (!found.ok && found.status === 404) notFound();
  if (!found.ok) {
    return (
      <main>
        <p role="alert">ミッションを取得できません: {found.message}</p>
      </main>
    );
  }
  const mission = found.value;
  const [plan, packet, events] = await Promise.all([
    callApi(`/v1/missions/${id}/plan`, {}, PlanDto),
    callApi(`/v1/missions/${id}/acceptance-packet`, {}, AcceptancePacketDto),
    callApi(`/v1/missions/${id}/events?limit=500`, {}, MissionEventListDto),
  ]);
  // Controls the role cannot use are not shown; the API refuses them anyway.
  const me = await currentUser();
  // The plan version a person can approve or reject now, if any.
  const decidable =
    allows(me, "plan:approve") &&
    mission.status === "AWAITING_PLAN_APPROVAL" &&
    plan.ok &&
    plan.value.version === mission.planVersion
      ? plan.value
      : undefined;

  return (
    <main>
      <p>
        <Link href="/missions">← ミッション</Link>
      </p>
      <h1>{mission.title}</h1>
      {error === undefined ? null : <p role="alert">操作できませんでした: {error}</p>}

      <dl className="facts">
        <dt>状態</dt>
        <dd>
          <StatusBadge status={mission.status} />
          {mission.reason === undefined ? null : <span className="reason"> {mission.reason}</span>}
        </dd>
        <dt>Issue</dt>
        <dd>
          {mission.source === undefined ? (
            "-"
          ) : (
            <ExternalLink
              url={`https://github.com/${mission.source.owner}/${mission.source.repo}/issues/${String(mission.source.issueNumber)}`}
            >
              {`${mission.source.owner}/${mission.source.repo}#${String(mission.source.issueNumber)}`}
            </ExternalLink>
          )}
          {mission.source === undefined ? null : ` (ベース: ${mission.source.baseBranch})`}
        </dd>
        {mission.approvedPlanVersion === undefined ? null : (
          <>
            <dt>承認された計画</dt>
            <dd>版 {mission.approvedPlanVersion}</dd>
          </>
        )}
      </dl>

      <div className="actions">
        {mission.status === "DRAFT" && allows(me, "mission:plan") ? (
          <form action={startPlanning}>
            <Hidden mission={mission} />
            <button type="submit">計画を始める</button>
          </form>
        ) : null}
        {FINISHED.has(mission.status) || !allows(me, "mission:cancel") ? null : (
          <form action={cancelMission}>
            <Hidden mission={mission} />
            <button type="submit" className="danger">
              キャンセル
            </button>
          </form>
        )}
      </div>

      <section>
        <h2>計画{plan.ok ? ` (版 ${String(plan.value.version)})` : ""}</h2>
        {!plan.ok ? (
          <p className="muted">
            {plan.status === 404 ? "まだ計画はありません。" : `取得できません: ${plan.message}`}
          </p>
        ) : (
          <>
            <pre className="plan">{plan.value.body}</pre>
            <p className="muted">
              作成: {plan.value.author.kind}
              {plan.value.author.id === undefined ? "" : ` (${plan.value.author.id})`}、
              {new Date(plan.value.createdAt).toLocaleString("ja-JP")}、SHA-256{" "}
              <code>{plan.value.checksumSha256.slice(0, 12)}</code>
            </p>
          </>
        )}
        {decidable !== undefined ? (
          <div className="decide">
            <form action={approvePlan} className="stack">
              <Hidden mission={mission} />
              <input type="hidden" name="planVersion" value={decidable.version} />
              <label>
                コメント(任意)
                <textarea name="comment" maxLength={4000} rows={2} />
              </label>
              <button type="submit">版 {decidable.version} を承認して実行する</button>
            </form>
            <form action={rejectPlan} className="stack">
              <Hidden mission={mission} />
              <input type="hidden" name="planVersion" value={decidable.version} />
              <label>
                差し戻しの理由
                <textarea name="reason" required maxLength={4000} rows={2} />
              </label>
              <button type="submit" className="secondary">
                差し戻す
              </button>
            </form>
          </div>
        ) : null}
      </section>

      {packet.ok ? <Packet packet={packet.value} /> : null}

      <section>
        <h2>イベント</h2>
        {events.ok ? (
          <EventLog missionId={mission.id} initial={events.value.items} />
        ) : (
          <p className="muted">取得できません: {events.message}</p>
        )}
      </section>
    </main>
  );
}

function Packet({ packet }: { readonly packet: AcceptancePacketDto }) {
  const { content } = packet;
  return (
    <section>
      <h2>受け入れ用のまとめ (版 {packet.version})</h2>
      <dl className="facts">
        <dt>Pull request</dt>
        <dd>
          <ExternalLink url={content.pullRequest.url}>
            {`#${String(content.pullRequest.number)} (${content.pullRequest.branch})`}
          </ExternalLink>
        </dd>
        <dt>CI</dt>
        <dd>
          {content.ci.state === "none" ? "CI の結果なし" : "成功"}
          <ul>
            {content.ci.checks.map((c) => (
              <li key={`${c.name}-${c.url ?? ""}`}>
                {c.url === null ? c.name : <ExternalLink url={c.url}>{c.name}</ExternalLink>}:{" "}
                {c.state}
              </li>
            ))}
          </ul>
        </dd>
        <dt>変更</dt>
        <dd>
          {content.diff.files.length} ファイル、+{content.diff.additions} / -
          {content.diff.deletions}
          {content.diff.truncated ? "(一覧は途中まで)" : ""}
          <ul>
            {content.diff.files.map((f) => (
              <li key={f.path}>
                <code>{f.path}</code> +{f.additions} / -{f.deletions}
              </li>
            ))}
          </ul>
        </dd>
        <dt>費用</dt>
        <dd>{content.costUsd === null ? "-" : `USD ${content.costUsd.toFixed(3)}`}</dd>
      </dl>
      <h3>受け入れ条件 (計画の版 {content.plan.version})</h3>
      <pre className="plan">
        {content.plan.acceptanceCriteria ?? "(計画に受け入れ条件がありません)"}
      </pre>
      <h3>残るリスク</h3>
      <ul>
        {content.residualRisks.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      <h3>承認の履歴</h3>
      <ul>
        {content.approvals.map((a) => (
          <li key={`${String(a.version)}-${a.decidedAt}`}>
            版 {a.version}: {a.decision === "approved" ? "承認" : "差し戻し"} (
            {new Date(a.decidedAt).toLocaleString("ja-JP")})
            {a.comment === null ? "" : ` — ${a.comment}`}
          </li>
        ))}
      </ul>
      <p className="muted">
        SHA-256 <code>{packet.checksumSha256.slice(0, 12)}</code>
      </p>
    </section>
  );
}
