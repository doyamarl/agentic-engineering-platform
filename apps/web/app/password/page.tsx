import { changePassword } from "../auth-actions";
import { currentUser } from "../lib/me";

export const dynamic = "force-dynamic";

export default async function PasswordPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const me = await currentUser();
  return (
    <main>
      <h1>パスワードの変更</h1>
      {me?.mustChangePassword === true ? (
        <p>
          管理者が発行したパスワードでログインしています。使い始める前に、新しいパスワードに変えてください。
        </p>
      ) : null}
      {error === undefined ? null : <p role="alert">変更できませんでした: {error}</p>}
      <form action={changePassword} className="stack">
        <label>
          今のパスワード
          <input
            name="currentPassword"
            type="password"
            autoComplete="current-password"
            required
            maxLength={256}
          />
        </label>
        <label>
          新しいパスワード（12 文字以上）
          <input
            name="newPassword"
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            maxLength={256}
          />
        </label>
        <label>
          新しいパスワード（確認）
          <input
            name="confirmPassword"
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            maxLength={256}
          />
        </label>
        <button type="submit">変更する</button>
      </form>
      <p className="muted">変更すると、ほかの端末のログインもすべて終わります。</p>
    </main>
  );
}
