# Agentic Software Engineering Platform

セルフホスト前提・エージェント非依存のソフトウェアデリバリー基盤。現在は Sprint 1（基盤）の実装段階で、テナントスコープの Mission を API で作成・取得できる。エージェント実行・承認フロー・UI はまだない（[ロードマップ](docs/03_ROADMAP.md)）。

## ドキュメント

- [docs/01_PRD.md](docs/01_PRD.md) — プロダクト要求(ビジョン、KPI、ペルソナ、リリースごとのスコープ)
- [docs/02_ARCHITECTURE_ADR.md](docs/02_ARCHITECTURE_ADR.md) — アーキテクチャ方針と技術選定(ADR)
- [docs/03_ROADMAP.md](docs/03_ROADMAP.md) — MVP から OSS v1.0 までのロードマップ
- [docs/04_AGENT_BENCHMARK.md](docs/04_AGENT_BENCHMARK.md) — 最初のエージェントアダプタ（Claude）の可否判定ベンチマーク手順

## クイックスタート（Docker Compose）

必要なもの: Docker と Docker Compose v2。ローカルの信頼できる利用者向け（ADR §7 の T0）の構成で、公開ポートは `127.0.0.1` にしか開かない。

```bash
# アクセストークンの署名鍵（32 バイト以上）。初回だけ
echo "AEP_ACCESS_TOKEN_SECRET=$(openssl rand -base64 48)" >> infra/compose/.env

docker compose -f infra/compose/compose.yaml up -d --build --wait

# テナント・workspace・admin を作成し、admin の API トークンと初期パスワードを1回だけ表示する
docker compose -f infra/compose/compose.yaml run --rm migrate \
  node apps/api/src/cli/bootstrap.ts --tenant Demo --workspace Growth --admin Operator \
  --email admin@example.com
```

Web の画面（http://127.0.0.1:3001）を開くとログイン画面になる。bootstrap の出力の `email` と `initialPassword` でログインし、最初にパスワードを変える。画面では、ミッションの一覧と作成（GitHub の Issue を指定）、詳細（状態、計画、承認・差し戻し、数秒ごとに更新されるイベント、受け入れ用のまとめ、キャンセル）を扱える。ロールで使えない操作のボタンは出ない。計画と実行には worker の設定（`apps/worker/src/execution.ts` の環境変数）が要る。作成画面では、テナントの Workspace を一覧から選ぶ。

API はスクリプトから API トークンでも使える。

```bash
TOKEN=aep_...        # 上の出力の token
WORKSPACE=...        # 上の出力の workspaceId
curl -s -X POST http://127.0.0.1:3000/v1/missions \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"workspaceId\":\"$WORKSPACE\",\"title\":\"Improve signup conversion\"}"
curl -s http://127.0.0.1:3000/v1/missions -H "authorization: Bearer $TOKEN"
```

パスワードでのログイン（ADR-011）は、API に `AEP_AUTH_METHODS=password` と `AEP_ACCESS_TOKEN_SECRET_FILE`（署名鍵のファイル）を渡すと有効になる。Compose の構成では有効にしてあり、鍵は `.env` の `AEP_ACCESS_TOKEN_SECRET` から渡す。admin は Web の「メンバー」（`/admin/members`）か API の `/v1/members` で、メンバーの登録（初期パスワードが 1 回だけ表示される）、ロールの変更、無効化、パスワードの再発行ができる。これらの変更とログインの結果は、Web の監査ログ（`/admin/audit`）か `/v1/audit-events` で見られる。会社の IdP でのログイン（OIDC）は、`AEP_AUTH_METHODS` に `oidc` を加え、`AEP_OIDC_ISSUER`、`AEP_OIDC_CLIENT_ID`、`AEP_OIDC_CLIENT_SECRET_FILE`、`AEP_OIDC_REDIRECT_URI`（Web の `/login/oidc/callback`。IdP にも同じ値を登録する）、表示名の `AEP_OIDC_NAME` を渡すと有効になる。ログインできるのは admin が登録したメンバーだけで、IdP が `email_verified: true` を返したメールアドレスで照合する。Web はセッションを HttpOnly の Cookie に持つ。Compose は `127.0.0.1` の平文 HTTP なので `AEP_SECURE_COOKIES=false` にしている。TLS の後ろで動かすときは外す。

外部ツールへの接続（コネクタ、ADR-013）は既定ではオフ。オンにするには `infra/compose/.env` に `COMPOSE_FILE=compose.yaml:compose.connectors.yaml` と `AEP_MASTER_KEY`（`openssl rand -base64 32` の出力）を書く。トークンは worker がこの鍵で暗号化して DB に保管する。鍵をなくすと、全員の接続をやり直すことになる。DB のバックアップとは別の場所に控えておく。各メンバーは Web の「接続」（`/connections`）から自分のアカウントで接続し、admin は「メンバーの接続」（`/admin/connections`）で接続の状態を見て、強制的に切断できる。リダイレクト URI は既定で `http://127.0.0.1:3001/connections/oauth/callback`。別のアドレスで公開するときは `AEP_CONNECTOR_REDIRECT_URI` で変える。

| サービス | URL                   | 内容                                                 |
| -------- | --------------------- | ---------------------------------------------------- |
| api      | http://127.0.0.1:3000 | `/healthz`、`/v1/missions`                           |
| web      | http://127.0.0.1:3001 | ログイン、ミッションの一覧・作成・詳細               |
| worker   | （公開なし）          | DB 疎通のヘルスチェックのみ（ジョブ処理は Sprint 2） |

ブラウザのテスト（Playwright、`tools/e2e`）は `infra/compose/e2e.sh` で実行する。スタックを起動し、テナント A・B のアカウント（A と B の admin、A の viewer と engineer、初期パスワードのままの A のメンバー）と A のミッションを用意して、Web にログインしながら、画面の通しの操作、ログインまわり（初回のパスワード変更、ログアウト、ロールによるボタンの出し分け）、偽の MCP サーバー（`tools/mock-mcp`）への接続と切断、セキュリティの回帰テスト（テナント分離、HTML の注入、リンクのスキーム、フレームへの埋め込み、別サイトからのフォーム送信、Cookie とトークンの露出）を流す（CI でも実行）。初回は `pnpm --filter @aep/e2e exec playwright install chromium` でブラウザを取得する。

DB のパスワードはローカル用の既定値が入っている。変える場合は `infra/compose/.env.example` を `infra/compose/.env` にコピーして編集する。`infra/compose/smoke.sh` は起動からテナント分離の確認までを通しで実行する（CI でも実行）。

## 開発環境

Node と pnpm のバージョンは [mise](https://mise.jdx.dev/) で `mise.toml` に固定している（Node 24 / pnpm 10）。

```bash
mise install
pnpm install
pnpm verify   # format / lint / typecheck / 依存境界チェック / テスト
```

`adapters/persistence/postgres` のテストは Testcontainers で PostgreSQL 18 を起動するため、Docker が必要。

モジュール境界のルールは `.dependency-cruiser.cjs` にあり、`architecture/dependency-rules.test.ts` が各ルールの違反 fixture を検出できることを確認している。

## ライセンス

[Apache License 2.0](LICENSE)
