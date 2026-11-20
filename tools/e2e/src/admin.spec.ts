import { expect, test, type Browser, type Page } from "@playwright/test";
import { fixtures, logIn } from "./fixtures.ts";

// Member administration through the UI (ADR-011, #33): an admin of tenant A registers members,
// changes roles, disables them and resets passwords; others cannot reach the pages.

test.use({ baseURL: fixtures.web });

/** Registers a member through the form and returns the password shown once. */
async function register(page: Page, name: string, role = "engineer") {
  const email = `${name.toLowerCase().replaceAll(" ", "-")}-${String(Date.now())}@example.com`;
  await page.goto("/admin/members");
  const form = page.locator("section", { hasText: "メンバーを登録する" });
  await form.getByLabel("表示名").fill(name);
  await form.getByLabel("メールアドレス").fill(email);
  await form.getByLabel("ロール").selectOption(role);
  await form.getByRole("button", { name: "登録する" }).click();
  const issued = form.locator(".issued code");
  await expect(issued).toBeVisible();
  const password = (await issued.textContent()) ?? "";
  expect(password.length).toBeGreaterThanOrEqual(12);
  expect(page.url()).not.toContain(password);
  return { email, password };
}

/** Tries a login in a fresh browser context and returns the page it ended on. */
async function loginElsewhere(browser: Browser, email: string, password: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${fixtures.web}/login`);
  await page.getByLabel("メールアドレス").fill(email);
  await page.getByLabel("パスワード").fill(password);
  await page.getByRole("button", { name: "ログインする", exact: true }).click();
  await page.waitForLoadState("networkidle");
  return { page, close: () => context.close() };
}

test.describe("as tenant A's admin", () => {
  test.beforeEach(async ({ page }) => {
    await logIn(page, fixtures.accounts.adminA());
  });

  test("registers a member whose one-time password logs in and must be changed", async ({
    page,
    browser,
  }) => {
    await page.getByRole("link", { name: "メンバー", exact: true }).click();
    await expect(page.getByRole("heading", { name: "メンバー", exact: true })).toBeVisible();
    const { email, password } = await register(page, "UI Newcomer");
    await expect(page.getByRole("row", { name: /UI Newcomer/ })).toContainText(email);

    // Shown once: a reload does not bring it back.
    await page.reload();
    await expect(page.locator(".issued")).toHaveCount(0);

    const other = await loginElsewhere(browser, email, password);
    await expect(other.page).toHaveURL(/\/password$/);
    await other.close();
  });

  test("changes a role and disables a member, who then cannot log in", async ({
    page,
    browser,
  }) => {
    const { email, password } = await register(page, "UI Changed");
    const row = page.getByRole("row", { name: /UI Changed/ });
    await row.getByLabel("UI Changed のロール").selectOption("viewer");
    await row.getByRole("button", { name: "変更" }).click();
    await expect(
      page.getByRole("row", { name: /UI Changed/ }).getByLabel("UI Changed のロール"),
    ).toHaveValue("viewer");

    await page.getByRole("button", { name: "UI Changed を無効にする" }).click();
    await expect(page.getByRole("row", { name: /UI Changed/ })).toContainText("無効");
    const other = await loginElsewhere(browser, email, password);
    await expect(other.page.locator("p[role=alert]")).toContainText(
      "メールアドレスかパスワードが違います",
    );
    await other.close();

    await page.getByRole("button", { name: "UI Changed を有効にする" }).click();
    await expect(page.getByRole("row", { name: /UI Changed/ })).toContainText("有効");
  });

  test("resets a password: the old one stops working, the new one must be changed", async ({
    page,
    browser,
  }) => {
    const { email, password } = await register(page, "UI Reset");
    await page.getByRole("button", { name: "UI Reset のパスワードを再発行" }).click();
    const issued = page.getByRole("row", { name: /UI Reset/ }).locator(".issued code");
    await expect(issued).toBeVisible();
    const next = (await issued.textContent()) ?? "";
    expect(next).not.toBe(password);

    const old = await loginElsewhere(browser, email, password);
    await expect(old.page.locator("p[role=alert]")).toBeVisible();
    await old.close();
    const fresh = await loginElsewhere(browser, email, next);
    await expect(fresh.page).toHaveURL(/\/password$/);
    await fresh.close();
  });

  test("refuses to demote the tenant's only admin", async ({ page }) => {
    await page.goto("/admin/members");
    const self = page.getByRole("row", { name: /（自分）/ });
    await self.getByRole("combobox").selectOption("planner");
    await self.getByRole("button", { name: "変更" }).click();
    await expect(page.locator("p[role=alert]")).toContainText("at least one active admin");
    await expect(page.getByRole("row", { name: /（自分）/ }).getByRole("combobox")).toHaveValue(
      "admin",
    );
  });

  test("lists member changes and logins in the audit log, without passwords", async ({ page }) => {
    const { password } = await register(page, "UI Audited");
    await page.getByRole("link", { name: "監査ログ" }).click();
    await expect(page.getByRole("heading", { name: "監査ログ" })).toBeVisible();
    await expect(page.getByRole("row", { name: /メンバーの登録.*UI Audited/ })).toBeVisible();
    await expect(page.getByRole("cell", { name: "ログイン", exact: true }).first()).toBeVisible();
    expect(await page.content()).not.toContain(password);
  });
});

test("shows the admin pages to nobody but admins", async ({ page }) => {
  await logIn(page, fixtures.accounts.viewerA());
  await expect(page.getByRole("link", { name: "メンバー", exact: true })).toHaveCount(0);
  expect((await page.goto("/admin/members"))?.status()).toBe(404);
  expect((await page.goto("/admin/audit"))?.status()).toBe(404);
});
