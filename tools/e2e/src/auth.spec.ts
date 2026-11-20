import { expect, test } from "@playwright/test";
import { fixtures, logIn } from "./fixtures.ts";

// Login, the first-login password change, logout and role-based controls (ADR-011, #33).

test.use({ baseURL: fixtures.web });

test("sends a visitor without a session to the login page and back after login", async ({
  page,
}) => {
  const target = `/missions/${fixtures.missions.accepted()}`;
  await page.goto(target);
  await expect(page).toHaveURL(/\/login\?next=/);
  await page.getByLabel("メールアドレス").fill(fixtures.accounts.adminA());
  await page.getByLabel("パスワード").fill(fixtures.password());
  await page.getByRole("button", { name: "ログインする", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${target}$`));
  await expect(page.getByTitle("ACCEPTANCE_READY")).toBeVisible();
});

test("answers a wrong password with one message and keeps the password out of the URL", async ({
  page,
}) => {
  await page.goto("/login");
  await page.getByLabel("メールアドレス").fill(fixtures.accounts.adminA());
  await page.getByLabel("パスワード").fill("wrong-password-123");
  await page.getByRole("button", { name: "ログインする", exact: true }).click();
  await expect(page.locator("p[role=alert]")).toContainText("メールアドレスかパスワードが違います");
  expect(page.url()).not.toContain("wrong-password");

  await page.getByLabel("メールアドレス").fill("nobody@example.com");
  await page.getByLabel("パスワード").fill(fixtures.password());
  await page.getByRole("button", { name: "ログインする", exact: true }).click();
  await expect(page.locator("p[role=alert]")).toContainText("メールアドレスかパスワードが違います");
});

test("does not follow a login redirect to another site", async ({ page }) => {
  await page.goto("/login?next=//evil.example/x");
  await page.getByLabel("メールアドレス").fill(fixtures.accounts.adminA());
  await page.getByLabel("パスワード").fill(fixtures.password());
  await page.getByRole("button", { name: "ログインする", exact: true }).click();
  await expect(page).toHaveURL(/127\.0\.0\.1:3001\/missions$/);
});

test("makes a newcomer change the admin-issued password before anything else", async ({ page }) => {
  await logIn(page, fixtures.accounts.newcomerA(), fixtures.accounts.newcomerPassword());
  await expect(page).toHaveURL(/\/password$/);
  await page.goto("/missions");
  await expect(page).toHaveURL(/\/password$/);

  await page.getByLabel("今のパスワード").fill(fixtures.accounts.newcomerPassword());
  await page.getByLabel("新しいパスワード（12 文字以上）").fill("newcomer-chose-this-one");
  await page.getByLabel("新しいパスワード（確認）").fill("newcomer-chose-this-one");
  await page.getByRole("button", { name: "変更する" }).click();
  await expect(page).toHaveURL(/\/missions$/);
  await expect(page.getByRole("heading", { name: "ミッション" })).toBeVisible();
});

test("logs out: the session ends and pages ask for a login again", async ({ page, context }) => {
  await logIn(page, fixtures.accounts.adminA());
  const refresh = (await context.cookies()).find((c) => c.name.endsWith("aep_rt"));
  await page.getByRole("button", { name: "ログアウト" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/missions");
  await expect(page).toHaveURL(/\/login\?next=/);

  // Putting the old refresh cookie back does not bring the session back: logout revoked it.
  if (refresh !== undefined) await context.addCookies([refresh]);
  await page.goto("/missions");
  await expect(page).toHaveURL(/\/login\?next=/);
});

test("shows a viewer no controls the role cannot use", async ({ page }) => {
  await logIn(page, fixtures.accounts.viewerA());
  await expect(page.getByText("ロール: viewer")).toBeVisible();
  await expect(page.getByRole("link", { name: "新しいミッション" })).toHaveCount(0);

  await page.goto(`/missions/${fixtures.missions.viewed()}`);
  await expect(page.getByTitle("AWAITING_PLAN_APPROVAL")).toBeVisible();
  await expect(page.locator("pre.plan")).toContainText("## Summary");
  await expect(page.getByRole("button", { name: /承認/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "差し戻す" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "キャンセル" })).toHaveCount(0);

  await page.goto(`/missions/${fixtures.missions.draft()}`);
  await expect(page.getByRole("button", { name: "計画を始める" })).toHaveCount(0);
});
