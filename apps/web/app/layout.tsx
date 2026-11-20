import Link from "next/link";
import type { ReactNode } from "react";
import { fetchApiStatus } from "./api-status";
import { logout } from "./auth-actions";
import { allows, currentUser } from "./lib/me";

export const metadata = { title: "Agentic Engineering Platform" };

const STYLE = `
body { font-family: system-ui, sans-serif; margin: 0; color: #1f2328; background: #fff; }
header { display: flex; gap: 1rem; align-items: baseline; padding: .75rem 2rem; border-bottom: 1px solid #d0d7de; }
header .status { margin-left: auto; font-size: .85rem; color: #59636e; }
header .user { display: flex; gap: .75rem; align-items: baseline; font-size: .85rem; }
main { padding: 1rem 2rem 3rem; max-width: 72rem; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid #d0d7de; }
.badge { display: inline-block; padding: .1rem .5rem; border-radius: 1rem; font-size: .85rem; background: #eaeef2; }
.badge-failed, .badge-blocked { background: #ffebe9; color: #a40e26; }
.badge-acceptance_ready, .badge-completed { background: #dafbe1; color: #116329; }
.badge-awaiting_plan_approval { background: #fff8c5; color: #7d4e00; }
.facts { display: grid; grid-template-columns: 10rem 1fr; gap: .4rem 1rem; }
.facts dd { margin: 0; }
.actions, .decide { display: flex; gap: 1rem; margin: 1rem 0; align-items: flex-start; flex-wrap: wrap; }
.stack { display: flex; flex-direction: column; gap: .5rem; max-width: 32rem; }
.stack label, fieldset label { display: flex; flex-direction: column; gap: .2rem; }
fieldset { display: flex; flex-direction: column; gap: .5rem; }
pre.plan { white-space: pre-wrap; background: #f6f8fa; padding: 1rem; border-radius: .4rem; }
button { padding: .4rem .9rem; cursor: pointer; }
button.danger { color: #a40e26; }
.muted { color: #59636e; font-size: .9rem; }
.reason { color: #a40e26; }
[role="alert"] { color: #a40e26; }
.events { padding-left: 1.2rem; }
form.inline { display: inline-flex; gap: .4rem; align-items: center; }
.issued { margin-top: .5rem; padding: .75rem 1rem; background: #fff8c5; border-radius: .4rem; }
.issued code { font-size: 1.1rem; user-select: all; }
.messages { display: flex; flex-direction: column; gap: .75rem; margin: 1rem 0; max-width: 48rem; }
.message { padding: .6rem .9rem; border-radius: .5rem; background: #f6f8fa; }
.message.assistant { background: #ddf4ff; }
.message .who { margin: 0 0 .3rem; font-size: .85rem; font-weight: 600; }
.message .content { white-space: pre-wrap; overflow-wrap: anywhere; }
label.choice { flex-direction: row; align-items: center; gap: .4rem; }
label.choice.indent { margin-left: 1.5rem; }
.approval { margin-top: .6rem; padding: .6rem .9rem; border: 1px solid #d4a72c; border-radius: .4rem; background: #fff8c5; }
.tool-notes { margin: 0 0 .4rem; padding-left: 1.2rem; font-size: .85rem; color: #59636e; }
.events .payload { display: block; font-size: .8rem; color: #59636e; overflow-wrap: anywhere; }
`;

export default async function RootLayout({ children }: { readonly children: ReactNode }) {
  const [api, me] = await Promise.all([fetchApiStatus(), currentUser()]);
  return (
    <html lang="ja">
      <head>
        <style>{STYLE}</style>
      </head>
      <body>
        <header>
          <Link href="/missions">
            <strong>Agentic Engineering Platform</strong>
          </Link>
          <span className="status">
            API: {api.reachable ? "接続中" : `接続できません (${api.detail})`}
          </span>
          {me === undefined ? null : (
            <span className="user">
              <Link href="/threads">スレッド</Link>
              <Link href="/missions">ミッション</Link>
              {allows(me, "connector:use") ? <Link href="/connections">接続</Link> : null}
              <span>ロール: {me.role}</span>
              {allows(me, "member:manage") ? <Link href="/admin/members">メンバー</Link> : null}
              {allows(me, "connector:manage") ? (
                <Link href="/admin/connections">メンバーの接続</Link>
              ) : null}
              {allows(me, "settings:manage") ? <Link href="/admin/settings">設定</Link> : null}
              <Link href="/password">パスワードの変更</Link>
              <form action={logout}>
                <button type="submit">ログアウト</button>
              </form>
            </span>
          )}
        </header>
        {children}
      </body>
    </html>
  );
}
