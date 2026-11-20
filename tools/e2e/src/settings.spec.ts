import { expect, test } from "@playwright/test";
import { fixtures, logIn } from "./fixtures.ts";

// Tenant settings (#43): a tenant admin chooses the model for thread replies.

test.use({ baseURL: fixtures.web });

test("an admin chooses the reply model, and the change is audited", async ({ page }) => {
  await logIn(page, fixtures.accounts.adminA());
  await page.getByRole("link", { name: "設定" }).click();
  await expect(page.getByRole("heading", { name: "テナントの設定" })).toBeVisible();

  const model = page.getByLabel("スレッドの返答に使うモデル");
  await model.selectOption("claude-opus-5-5");
  await page.getByRole("button", { name: "保存する" }).click();
  await expect(page.getByRole("status")).toHaveText("保存しました。");
  await page.reload();
  await expect(model).toHaveValue("claude-opus-5-5");

  await page.goto("/admin/audit");
  await expect(page.getByRole("cell", { name: "返答のモデルの変更" }).first()).toBeVisible();

  // Back to the default, so other runs against the same stack start there.
  await page.goto("/admin/settings");
  await model.selectOption("");
  await page.getByRole("button", { name: "保存する" }).click();
  await expect(model).toHaveValue("");
});

test("a viewer has no settings page", async ({ page }) => {
  await logIn(page, fixtures.accounts.viewerA());
  await expect(page.getByRole("link", { name: "設定" })).toHaveCount(0);
  expect((await page.goto("/admin/settings"))?.status()).toBe(404);
});
