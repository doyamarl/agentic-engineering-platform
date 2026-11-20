import { expect, test } from "@playwright/test";
import { fixtures, logIn } from "./fixtures.ts";

// The Sprint 3 golden path through the UI, as far as it goes without an agent: the Compose
// worker has no agent credentials, so plans and packets were written by the setup script.

test.use({ baseURL: fixtures.web });

test.beforeEach(async ({ page }) => {
  await logIn(page, fixtures.accounts.adminA());
});

test("creates a mission from an issue, starts planning and cancels it", async ({ page }) => {
  await page.goto("/missions");
  await page.getByRole("link", { name: "新しいミッション" }).click();
  await page.getByLabel("タイトル").fill("E2E created mission");
  // Tenant A's only workspace, picked from the list instead of typed in (#29).
  await expect(page.getByLabel("Workspace")).toHaveValue(/^[0-9a-f-]{36}$/);
  await page.getByLabel("Owner").fill("acme");
  await page.getByLabel("Repository").fill("shop");
  await page.getByLabel("Issue 番号").fill("42");
  await page.getByRole("button", { name: "作成する" }).click();

  await expect(page).toHaveURL(/\/missions\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: "E2E created mission" })).toBeVisible();
  await expect(page.getByTitle("DRAFT")).toBeVisible();
  await expect(page.getByRole("link", { name: "acme/shop#42" })).toHaveAttribute(
    "href",
    "https://github.com/acme/shop/issues/42",
  );

  await page.getByRole("button", { name: "計画を始める" }).click();
  await expect(page.getByTitle("PLANNING")).toBeVisible();
  await page.getByRole("button", { name: "キャンセル" }).click();
  await expect(page.getByTitle("CANCEL_REQUESTED")).toBeVisible();
  await expect(page.locator(".events")).toContainText("StartPlanning");
  await expect(page.locator(".events")).toContainText("Cancel");

  await page.goto("/missions");
  await expect(page.getByRole("link", { name: "E2E created mission" })).toBeVisible();
});

test("approves the plan awaiting approval with the keyboard, which starts execution", async ({
  page,
}) => {
  await page.goto(`/missions/${fixtures.missions.awaitingApproval()}`);
  await expect(page.getByRole("heading", { name: "計画 (版 1)" })).toBeVisible();
  await expect(page.locator("pre.plan")).toContainText("## Acceptance criteria");

  await page.getByLabel("コメント(任意)").fill("looks good");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "版 1 を承認して実行する" })).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(page.getByTitle("EXECUTING")).toBeVisible();
  await expect(page.getByText("版 1", { exact: true })).toBeVisible();
  await expect(page.locator(".events")).toContainText("ApprovePlan");
  await expect(page.locator(".events")).toContainText("StartExecution");
});

test("rejects a plan with a reason, which sends the mission back to planning", async ({ page }) => {
  await page.goto(`/missions/${fixtures.missions.awaitingRejection()}`);
  const reject = page.getByRole("button", { name: "差し戻す" });
  // The reason is required: an empty form is not sent.
  await reject.click();
  await expect(page.getByTitle("AWAITING_PLAN_APPROVAL")).toBeVisible();

  await page.getByLabel("差し戻しの理由").fill("Add a test for empty input.");
  await reject.click();
  await expect(page.getByTitle("PLANNING")).toBeVisible();
  await expect(page.locator(".events")).toContainText("RejectPlan");
  await expect(page.getByRole("button", { name: "差し戻す" })).toHaveCount(0);
});

test("shows the acceptance packet of an acceptance-ready mission", async ({ page }) => {
  await page.goto(`/missions/${fixtures.missions.accepted()}`);
  await expect(page.getByTitle("ACCEPTANCE_READY")).toBeVisible();
  const packet = page.locator("section", { hasText: "受け入れ用のまとめ (版 1)" });
  await expect(packet.getByRole("link", { name: /#9 / })).toHaveAttribute(
    "href",
    "https://github.com/acme/shop/pull/9",
  );
  await expect(packet).toContainText("src/truncate.js");
  await expect(packet).toContainText("USD 0.102");
  await expect(packet).toContainText("node --test passes");
});
