import { expect, test, type Browser, type Page } from "@playwright/test";
import { fixtures, logIn } from "./fixtures.ts";

// Personal connections (#52). The connectors of the e2e stack point at the mock MCP server
// (compose.e2e.yaml), which approves an authorization at once and records revocations.

test.use({ baseURL: fixtures.web });

type MockState = {
  readonly revoked: readonly string[];
  readonly toolCalls: readonly {
    readonly tool: string;
    readonly token: string;
    readonly arguments: unknown;
  }[];
};

async function mockState(): Promise<MockState> {
  const response = await fetch(`${fixtures.mockMcp}/_mock/state`);
  return (await response.json()) as MockState;
}

const card = (page: Page) => page.getByRole("region", { name: "Mock Amplitude" });

async function connect(page: Page) {
  await page.goto("/connections");
  await card(page).getByRole("button", { name: "Mock Amplitude に接続する" }).click();
  // Out to the provider and back; the worker then exchanges the code in the background.
  await expect(page).toHaveURL(/\/connections$/);
  await expect(card(page).getByText("接続済み", { exact: true })).toBeVisible({ timeout: 20_000 });
}

async function as(browser: Browser, email: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await logIn(page, email);
  return page;
}

test("a member connects with their own account and disconnects, revoking the tokens", async ({
  page,
}) => {
  await logIn(page, fixtures.accounts.adminA());
  await connect(page);
  await expect(card(page)).toContainText("manage_amp_entities");

  const revokedBefore = (await mockState()).revoked.length;
  await card(page).getByRole("button", { name: "Mock Amplitude から切断する" }).click();
  await expect(card(page).getByText("未接続", { exact: true })).toBeVisible({ timeout: 20_000 });
  // The refresh token and the access token, revoked at the provider before they were deleted.
  expect((await mockState()).revoked.length - revokedBefore).toBe(2);
});

test("an admin sees who is connected, without tokens, and disconnects a member", async ({
  page,
  browser,
}) => {
  const engineer = await as(browser, fixtures.accounts.engineerA());
  await connect(engineer);

  await logIn(page, fixtures.accounts.adminA());
  await page.goto("/admin/connections");
  const row = page.getByRole("row", { name: /E2E engineer/ });
  await expect(row).toContainText("Mock Amplitude");
  await expect(row).toContainText("接続済み");
  // Status only: nothing on the page looks like one of the mock server's tokens.
  await expect(page.locator("body")).not.toContainText("mock_");

  const revokedBefore = (await mockState()).revoked.length;
  await row.getByRole("button", { name: "E2E engineer の Mock Amplitude を切断する" }).click();
  await expect(page.getByRole("row", { name: /E2E engineer/ })).toHaveCount(0, {
    timeout: 20_000,
  });
  expect((await mockState()).revoked.length - revokedBefore).toBe(2);

  await engineer.goto("/connections");
  await expect(card(engineer).getByText("未接続", { exact: true })).toBeVisible();
});

test("a reply reads the funnel through the asker's connection", async ({ page }) => {
  await logIn(page, fixtures.accounts.engineerA());
  await connect(page);
  const callsBefore = (await mockState()).toolCalls.length;

  await page.goto("/threads");
  await page.getByLabel("タイトル").fill("E2E funnel thread");
  await expect(page.getByLabel("Workspace")).toHaveValue(/^[0-9a-f-]{36}$/);
  await page.getByRole("button", { name: "スレッドを作る" }).click();
  await expect(page).toHaveURL(/\/threads\/[0-9a-f-]{36}$/);
  // The fake model of the e2e stack calls the tool a message names this way.
  await page.getByLabel("メッセージ").fill("/tool query_amplitude_data");
  await page.getByRole("button", { name: "送信する" }).click();

  const reply = page.locator("article.message.assistant");
  await expect(reply.last()).toContainText("Fake reply from the tool result", {
    timeout: 20_000,
  });
  await expect(reply.last()).toContainText("Signup funnel");
  const calls = (await mockState()).toolCalls.slice(callsBefore);
  expect(calls.map((c) => c.tool)).toEqual(["query_amplitude_data"]);
  // The token the call carried appears nowhere on the page.
  await expect(page.locator("body")).not.toContainText(calls[0]?.token ?? "mock_at_");

  await page.goto("/connections");
  await card(page).getByRole("button", { name: "Mock Amplitude から切断する" }).click();
  await expect(card(page).getByText("未接続", { exact: true })).toBeVisible({ timeout: 20_000 });
});

test("a write call waits for the asker's approval and runs once; a declined one never runs", async ({
  page,
  browser,
}) => {
  await logIn(page, fixtures.accounts.engineerA());
  await connect(page);
  const callsBefore = (await mockState()).toolCalls.length;
  const writes = async () =>
    (await mockState()).toolCalls
      .slice(callsBefore)
      .filter((c) => c.tool === "manage_amp_entities");

  await page.goto("/threads");
  await page.getByLabel("タイトル").fill("E2E cleanup thread");
  await expect(page.getByLabel("Workspace")).toHaveValue(/^[0-9a-f-]{36}$/);
  await page.getByRole("button", { name: "スレッドを作る" }).click();
  await expect(page).toHaveURL(/\/threads\/[0-9a-f-]{36}$/);
  const threadUrl = page.url();
  await page.getByRole("radio", { name: "ワークスペース全体" }).check();
  await page.getByRole("button", { name: "公開範囲を変える" }).click();
  await expect(page.getByText(/公開範囲: ワークスペース/)).toBeVisible();

  await page
    .getByLabel("メッセージ")
    .fill('/tool manage_amp_entities {"action":"delete","entityId":"chart-signup"}');
  await page.getByRole("button", { name: "送信する" }).click();
  const approval = page.getByRole("region", {
    name: "mock-amplitude の manage_amp_entities の承認",
  });
  await expect(approval).toContainText('"entityId": "chart-signup"', { timeout: 20_000 });
  await expect(approval).toContainText("期限:");
  expect(await writes()).toEqual([]);

  // The admin reads the shared thread and sees the card, but cannot decide for the engineer.
  const admin = await (await browser.newContext()).newPage();
  await logIn(admin, fixtures.accounts.adminA());
  await admin.goto(threadUrl);
  const seen = admin.getByRole("region", { name: "mock-amplitude の manage_amp_entities の承認" });
  await expect(seen).toContainText("の承認を待っています", { timeout: 20_000 });
  await expect(seen.getByRole("button")).toHaveCount(0);

  await approval.getByRole("button", { name: "この内容で実行する" }).click();
  const reply = page.locator("article.message.assistant");
  await expect(reply.last()).toContainText("Fake reply from the tool result", { timeout: 20_000 });
  expect((await writes()).map((c) => c.arguments)).toEqual([
    { action: "delete", entityId: "chart-signup" },
  ]);

  await page.getByLabel("メッセージ").fill('/tool manage_amp_entities {"action":"delete"}');
  await page.getByRole("button", { name: "送信する" }).click();
  await approval.getByRole("button", { name: "実行しない" }).click();
  await expect(reply.last()).toContainText("declined", { timeout: 20_000 });
  expect(await writes()).toHaveLength(1);

  await page.goto("/connections");
  await card(page).getByRole("button", { name: "Mock Amplitude から切断する" }).click();
  await expect(card(page).getByText("未接続", { exact: true })).toBeVisible({ timeout: 20_000 });
});

test("a viewer cannot connect", async ({ page }) => {
  await logIn(page, fixtures.accounts.viewerA());
  await expect(page.getByRole("link", { name: "接続", exact: true })).toHaveCount(0);
  expect((await page.goto("/connections"))?.status()).toBe(404);
  expect((await page.goto("/admin/connections"))?.status()).toBe(404);
});
