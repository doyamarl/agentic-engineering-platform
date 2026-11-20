import { WorkspaceListDto } from "@aep/contracts";
import Link from "next/link";
import { callApi } from "../../lib/api";
import { createMission } from "../actions";

export const dynamic = "force-dynamic";

export default async function NewMissionPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const workspaces = await callApi("/v1/workspaces", {}, WorkspaceListDto);
  return (
    <main>
      <p>
        <Link href="/missions">← ミッション</Link>
      </p>
      <h1>新しいミッション</h1>
      {error === undefined ? null : <p role="alert">作成できません: {error}</p>}
      <form action={createMission} className="stack">
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
        <fieldset>
          <legend>作業の元になる GitHub の Issue</legend>
          <label>
            Owner
            <input name="owner" required maxLength={100} />
          </label>
          <label>
            Repository
            <input name="repo" required maxLength={100} />
          </label>
          <label>
            Issue 番号
            <input name="issueNumber" type="number" min={1} required />
          </label>
          <label>
            ベースブランチ
            <input name="baseBranch" defaultValue="main" maxLength={255} />
          </label>
        </fieldset>
        <button type="submit">作成する</button>
      </form>
    </main>
  );
}
