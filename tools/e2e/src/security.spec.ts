import { expect, test } from "@playwright/test";
import { fixtures, logIn } from "./fixtures.ts";

// Security regressions through the UI (docs/01_PRD.md §8-A; ADR §2, ADR-011): tenant isolation,
// markup injection, link schemes, framing, cross-site form posts and credential exposure.

test.use({ baseURL: fixtures.web });

test.describe("tenant isolation (PRD §8-A)", () => {
  test("a user of tenant B cannot show, list or follow tenant A's mission", async ({ page }) => {
    await logIn(page, fixtures.accounts.adminB());
    const id = fixtures.missions.awaitingApproval();
    const detail = await page.goto(`/missions/${id}`);
    expect(detail?.status()).toBe(404);

    await page.goto("/missions");
    await expect(page.getByText("E2E", { exact: false })).toHaveCount(0);

    // page.request carries the browser's session cookies.
    const events = await page.request.get(`/missions/${id}/events?after=0`);
    expect(events.status()).toBe(404);
  });
});

test.describe("injection", () => {
  test.beforeEach(async ({ page }) => {
    await logIn(page, fixtures.accounts.adminA());
  });

  test("renders markup from titles, plans and packets as text and runs none of it", async ({
    page,
  }) => {
    const dialogs: string[] = [];
    page.on("dialog", (dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });
    await page.goto(`/missions/${fixtures.missions.hostile()}`);

    await expect(page.getByRole("heading", { level: 1 })).toHaveText(fixtures.hostileTitle);
    await expect(page.locator("pre.plan").first()).toContainText("<script>alert('plan')</script>");
    await expect(page.locator("img")).toHaveCount(0);
    expect(await page.evaluate(() => (globalThis as { __xss?: number }).__xss)).toBeUndefined();
    expect(dialogs).toEqual([]);
  });

  test("links no URL that is not https", async ({ page }) => {
    await page.goto(`/missions/${fixtures.missions.hostile()}`);
    await expect(page.getByText("evil-check")).toBeVisible();
    for (const scheme of ["javascript:", "data:", "http:"]) {
      await expect(page.locator(`a[href^="${scheme}"]`)).toHaveCount(0);
    }
  });
});

test.describe("browser protections", () => {
  test("forbids framing and referrers, also on the login page", async ({ request }) => {
    const response = await request.get("/login");
    expect(response.headers()["x-frame-options"]).toBe("DENY");
    expect(response.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(response.headers()["referrer-policy"]).toBe("no-referrer");
  });

  test("rejects a form post from another site, even with the session cookie", async ({ page }) => {
    await logIn(page, fixtures.accounts.adminA());
    const id = fixtures.missions.draft();
    await page.goto(`/missions/${id}`);
    await expect(page.getByTitle("DRAFT")).toBeVisible();
    const action = await page
      .locator('form:has(button:text-is("計画を始める")) input[name^="$ACTION_ID_"]')
      .getAttribute("name");
    expect(action).not.toBeNull();

    const forged = await page.request.post(`/missions/${id}`, {
      headers: { origin: "https://attacker.example" },
      multipart: { [action ?? ""]: "", missionId: id },
      maxRedirects: 0,
    });
    expect(forged.status()).toBeGreaterThanOrEqual(400);

    await page.reload();
    await expect(page.getByTitle("DRAFT")).toBeVisible();
  });

  test("keeps the session tokens in HttpOnly cookies, out of pages and scripts", async ({
    page,
    context,
  }) => {
    const bodies: string[] = [];
    page.on("response", (response) => {
      void response.text().then(
        (text) => bodies.push(text),
        () => undefined,
      );
    });
    await logIn(page, fixtures.accounts.adminA());
    await page.goto(`/missions/${fixtures.missions.accepted()}`);
    await page.waitForTimeout(3500); // one event poll

    const session = (await context.cookies()).filter((c) => /aep_(at|rt)$/.test(c.name));
    expect(session.map((c) => c.name).sort()).toEqual(["aep_at", "aep_rt"]);
    expect(session.every((c) => c.httpOnly && c.sameSite === "Lax")).toBe(true);
    const visible = await page.evaluate(
      () => (globalThis as { document?: { cookie: string } }).document?.cookie ?? "",
    );
    expect(visible).not.toContain("aep_");

    // Compare booleans only: a failure must not print a token into the CI log.
    const html = await page.content();
    for (const { name, value } of session) {
      expect(html.includes(value), `page HTML contains ${name}`).toBe(false);
      const leaking = bodies.filter((body) => body.includes(value)).length;
      expect(leaking, `responses containing ${name}`).toBe(0);
    }
  });
});
