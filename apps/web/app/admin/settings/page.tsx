import { ChatSettingsDto } from "@aep/contracts";
import { notFound } from "next/navigation";
import { callApi } from "../../lib/api";
import { allows, currentUser } from "../../lib/me";
import { setChatModel } from "./actions";

export const dynamic = "force-dynamic";

const MODEL_LABELS: Record<string, string> = {
  "claude-sonnet-5-5": "Claude Sonnet 5.5（速さと賢さの釣り合い）",
  "claude-opus-5-5": "Claude Opus 5.5（込み入った相談向け。料金は Sonnet の 2 倍）",
  "claude-haiku-5-5": "Claude Haiku 5.5（最も速く安い）",
};

export default async function SettingsPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const me = await currentUser();
  if (!allows(me, "settings:manage")) notFound();
  const { error, saved } = await searchParams;
  const settings = await callApi("/v1/settings/chat", {}, ChatSettingsDto);

  return (
    <main>
      <h1>テナントの設定</h1>
      {error === undefined ? null : <p role="alert">保存できません: {error}</p>}
      {saved === undefined ? null : <p role="status">保存しました。</p>}
      {!settings.ok ? (
        <p role="alert">設定を取得できません: {settings.message}</p>
      ) : (
        <form action={setChatModel} className="stack">
          <label>
            スレッドの返答に使うモデル
            <select name="model" defaultValue={settings.value.model ?? ""}>
              <option value="">インスタンスの既定（worker の AEP_CHAT_MODEL）</option>
              {settings.value.choices.map((id) => (
                <option key={id} value={id}>
                  {MODEL_LABELS[id] ?? id}
                </option>
              ))}
            </select>
          </label>
          <p className="muted">
            このテナントの次の返答から使われます。返答には実際に答えたモデルが表示されます。
          </p>
          <button type="submit">保存する</button>
        </form>
      )}
    </main>
  );
}
