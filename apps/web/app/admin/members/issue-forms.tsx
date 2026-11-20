"use client";

import { useActionState } from "react";
import { createMember, resetPassword, type IssuedPassword } from "../actions";

const IDLE: IssuedPassword = { kind: "idle" };

/** Shows an issued password once, with what to do with it. */
function Issued({ state }: { readonly state: IssuedPassword }) {
  if (state.kind === "failed") return <p role="alert">できませんでした: {state.message}</p>;
  if (state.kind !== "issued") return null;
  return (
    <div className="issued" role="status">
      <p>{state.email} の初期パスワード（この画面を離れると二度と表示されません）:</p>
      <output>
        <code>{state.initialPassword}</code>
      </output>
      <p className="muted">
        本人に安全な方法で渡してください。最初のログインで変更を求められます。
      </p>
    </div>
  );
}

const ROLES = ["viewer", "engineer", "planner", "admin"] as const;

export function CreateMemberForm() {
  const [state, action, pending] = useActionState(createMember, IDLE);
  return (
    <>
      <form action={action} className="stack">
        <label>
          表示名
          <input name="displayName" required maxLength={200} />
        </label>
        <label>
          メールアドレス
          <input name="email" type="email" required maxLength={254} />
        </label>
        <label>
          ロール
          <select name="role" defaultValue="engineer">
            {ROLES.map((role) => (
              <option key={role} value={role}>
                {role}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={pending}>
          登録する
        </button>
      </form>
      <Issued state={state} />
    </>
  );
}

export function ResetPasswordForm({
  userId,
  displayName,
}: {
  readonly userId: string;
  readonly displayName: string;
}) {
  const [state, action, pending] = useActionState(resetPassword, IDLE);
  return (
    <>
      <form action={action}>
        <input type="hidden" name="userId" value={userId} />
        <button type="submit" disabled={pending} aria-label={`${displayName} のパスワードを再発行`}>
          パスワードを再発行
        </button>
      </form>
      <Issued state={state} />
    </>
  );
}
