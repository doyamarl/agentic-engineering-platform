import { AuthMethodsDto } from "@aep/contracts";
import { login, oidcLogin } from "../auth-actions";
import { callApi } from "../lib/api";
import { safeNext } from "../lib/session";

export const dynamic = "force-dynamic";

const MESSAGES: Record<string, string> = {
  // One message for every refusal, as the API gives: it does not say which part was wrong.
  invalid:
    "メールアドレスかパスワードが違います。続けて間違えると、しばらくログインできなくなります。",
  oidc: "シングルサインオンでログインできませんでした。このメールアドレスが登録されているか、管理者に確認してください。",
  unavailable: "API に接続できません。時間をおいて試してください。",
};

export default async function LoginPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const { error, next } = await searchParams;
  const message = error === undefined ? undefined : MESSAGES[error];
  const methods = await callApi("/v1/auth/methods", { auth: false }, AuthMethodsDto);
  // If the API cannot say, offer the password form; a login attempt reports the real error.
  const offered = methods.ok ? methods.value : { password: true, oidc: null };
  return (
    <main>
      <h1>ログイン</h1>
      {message === undefined ? null : <p role="alert">{message}</p>}
      {offered.oidc === null ? null : (
        <form action={oidcLogin} className="stack">
          <input type="hidden" name="next" value={safeNext(next)} />
          <button type="submit">{offered.oidc.name} でログインする</button>
        </form>
      )}
      {!offered.password ? null : (
        <form action={login} className="stack">
          <input type="hidden" name="next" value={safeNext(next)} />
          <label>
            メールアドレス
            <input name="email" type="email" autoComplete="username" required maxLength={254} />
          </label>
          <label>
            パスワード
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              maxLength={256}
            />
          </label>
          <button type="submit">ログインする</button>
        </form>
      )}
    </main>
  );
}
