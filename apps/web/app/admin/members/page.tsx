import { MemberListDto } from "@aep/contracts";
import Link from "next/link";
import { notFound } from "next/navigation";
import { callApi } from "../../lib/api";
import { allows, currentUser } from "../../lib/me";
import { updateMember } from "../actions";
import { CreateMemberForm, ResetPasswordForm } from "./issue-forms";

export const dynamic = "force-dynamic";

const ROLES = ["viewer", "engineer", "planner", "admin"] as const;

export default async function MembersPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ error?: string }>;
}) {
  // Only admins see this page; for anyone else it does not exist. The API checks again.
  const me = await currentUser();
  if (!allows(me, "member:manage")) notFound();
  const { error } = await searchParams;
  const result = await callApi("/v1/members", {}, MemberListDto);

  return (
    <main>
      <h1>メンバー</h1>
      <p>
        <Link href="/admin/audit">監査ログ</Link>
      </p>
      {error === undefined ? null : <p role="alert">変更できませんでした: {error}</p>}
      {!result.ok ? (
        <p role="alert">一覧を取得できません: {result.message}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>表示名</th>
              <th>メールアドレス</th>
              <th>ロール</th>
              <th>状態</th>
              <th>パスワード</th>
            </tr>
          </thead>
          <tbody>
            {result.value.items.map((member) => (
              <tr key={member.userId}>
                <td>
                  {member.displayName}
                  {member.userId === me?.userId ? <span className="muted">（自分）</span> : null}
                </td>
                <td>{member.email ?? "-"}</td>
                <td>
                  <form action={updateMember} className="inline">
                    <input type="hidden" name="userId" value={member.userId} />
                    <select
                      name="role"
                      defaultValue={member.role}
                      aria-label={`${member.displayName} のロール`}
                    >
                      {ROLES.map((role) => (
                        <option key={role} value={role}>
                          {role}
                        </option>
                      ))}
                    </select>
                    <button type="submit">変更</button>
                  </form>
                </td>
                <td>
                  <form action={updateMember} className="inline">
                    <input type="hidden" name="userId" value={member.userId} />
                    <input type="hidden" name="disabled" value={String(!member.disabled)} />
                    {member.disabled ? "無効" : "有効"}{" "}
                    <button
                      type="submit"
                      className={member.disabled ? undefined : "danger"}
                      aria-label={`${member.displayName} を${member.disabled ? "有効にする" : "無効にする"}`}
                    >
                      {member.disabled ? "有効にする" : "無効にする"}
                    </button>
                  </form>
                </td>
                <td>
                  {member.email === null ? (
                    <span className="muted">メールアドレスなし</span>
                  ) : (
                    <ResetPasswordForm userId={member.userId} displayName={member.displayName} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <section>
        <h2>メンバーを登録する</h2>
        <CreateMemberForm />
      </section>
    </main>
  );
}
