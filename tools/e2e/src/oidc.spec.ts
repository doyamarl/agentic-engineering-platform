import { expect, test, type Page } from "@playwright/test";
import { fixtures } from "./fixtures.ts";

// OIDC login through the browser (ADR-011, #33), against the mock provider of compose.e2e.yaml:
// its form takes the subject and the claims the ID token should carry.

test.use({ baseURL: fixtures.web });

/** Starts the SSO login and signs in at the provider as `subject` with `claims`. */
async function signInAtProvider(page: Page, subject: string, claims: object) {
  await page.goto("/login");
  await page.getByRole("button", { name: "E2E SSO でログインする" }).click();
  await expect(page).toHaveURL(/^http:\/\/oidc:18080\/default\/authorize/);
  await page.locator('input[name="username"]').fill(subject);
  await page.locator('textarea[name="claims"]').fill(JSON.stringify(claims));
  await page.locator('input[type="submit"]').click();
}

test("logs a registered member in through the company provider", async ({ page, context }) => {
  const email = fixtures.accounts.viewerA();
  await signInAtProvider(page, `idp-${email}`, { email, email_verified: true });
  await expect(page).toHaveURL(/127\.0\.0\.1:3001\/missions$/);
  await expect(page.getByText("ロール: viewer")).toBeVisible();
  // The one-time checks are gone after the callback.
  expect((await context.cookies()).some((c) => c.name.endsWith("aep_oidc") && c.value !== "")).toBe(
    false,
  );
});

test("refuses an unverified email and says why in general terms", async ({ page }) => {
  const email = fixtures.accounts.adminB();
  await signInAtProvider(page, `idp-unverified-${email}`, { email, email_verified: false });
  await expect(page).toHaveURL(/\/login\?error=oidc/);
  await expect(page.locator("p[role=alert]")).toContainText(
    "シングルサインオンでログインできませんでした",
  );
  await page.goto("/missions");
  await expect(page).toHaveURL(/\/login\?next=/);
});

test("refuses a callback that no login of this browser started", async ({ page }) => {
  await page.goto("/login/oidc/callback?code=forged&state=forged");
  await expect(page).toHaveURL(/\/login\?error=oidc$/);
});
