import { expect, test, type Browser, type Page } from "@playwright/test";
import { fixtures, logIn } from "./fixtures.ts";

// Threads (#43): a person talks with the model in a personal thread and shares it. The Compose
// worker answers with the fake model (compose.e2e.yaml), which echoes the message.

test.use({ baseURL: fixtures.web });

async function newThread(page: Page, title: string): Promise<string> {
  await page.goto("/threads");
  await page.getByLabel("タイトル").fill(title);
  await expect(page.getByLabel("Workspace")).toHaveValue(/^[0-9a-f-]{36}$/);
  await page.getByRole("button", { name: "スレッドを作る" }).click();
  await expect(page).toHaveURL(/\/threads\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  return page.url();
}

async function send(page: Page, content: string) {
  await page.getByLabel("メッセージ").fill(content);
  await page.getByRole("button", { name: "送信する" }).click();
}

async function asViewer(browser: Browser): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await logIn(page, fixtures.accounts.viewerA());
  return page;
}

test("creates a thread, sends a message and shows the model's reply", async ({ page }) => {
  await logIn(page, fixtures.accounts.adminA());
  await newThread(page, "E2E signup thread");
  await expect(page.getByText("公開範囲: 個人")).toBeVisible();

  await page.getByLabel("返答の深さ").selectOption({ label: "じっくり" });
  await send(page, "Why did signups drop last week?");

  const reply = page.locator("article.message.assistant");
  await expect(reply).toContainText("Fake reply to: Why did signups drop last week?", {
    timeout: 20_000,
  });
  await expect(reply).toContainText("fake-echo");
  await expect(page.locator("article.message.user")).toContainText(
    "Why did signups drop last week?",
  );

  await page.goto("/threads");
  await expect(page.getByRole("link", { name: "E2E signup thread" })).toBeVisible();
});

test("a personal thread stays hidden from another member until it is shared", async ({
  page,
  browser,
}) => {
  await logIn(page, fixtures.accounts.adminA());
  const url = await newThread(page, "E2E shared thread");
  await send(page, "Draft the experiment");
  await expect(page.locator("article.message.assistant")).toContainText("Fake reply to:", {
    timeout: 20_000,
  });

  const viewer = await asViewer(browser);
  expect((await viewer.goto(url))?.status()).toBe(404);
  await viewer.goto("/threads");
  await expect(viewer.getByRole("link", { name: "E2E shared thread" })).toHaveCount(0);

  await page.getByRole("radio", { name: "選んだメンバー" }).check();
  await page.getByRole("checkbox", { name: "E2E viewer" }).check();
  await page.getByRole("button", { name: "公開範囲を変える" }).click();
  await expect(page.getByText("公開範囲: 選んだメンバー")).toBeVisible();

  expect((await viewer.goto(url))?.status()).toBe(200);
  await expect(viewer.getByRole("heading", { name: "E2E shared thread" })).toBeVisible();
  await expect(viewer.locator("article.message.user")).toContainText("Draft the experiment");
  // A viewer reads shared threads but does not write in them.
  await expect(viewer.getByRole("button", { name: "送信する" })).toHaveCount(0);

  await page.getByRole("radio", { name: "個人（自分だけ）" }).check();
  await page.getByRole("button", { name: "公開範囲を変える" }).click();
  await expect(page.getByText("公開範囲: 個人")).toBeVisible();
  expect((await viewer.goto(url))?.status()).toBe(404);
});
