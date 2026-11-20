import { expect, type Page } from "@playwright/test";

// What infra/compose/e2e.sh prepared, read from the environment.

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set; run the tests through infra/compose/e2e.sh`);
  }
  return value;
}

export const fixtures = {
  web: process.env["E2E_WEB"] ?? "http://127.0.0.1:3001",
  /** The mock MCP server of compose.e2e.yaml, as the host reaches it. */
  mockMcp: process.env["E2E_MOCK_MCP"] ?? "http://127.0.0.1:8090",
  /** The password every prepared account (except the newcomer) logs in with. */
  password: () => required("E2E_PASSWORD"),
  accounts: {
    adminA: () => required("E2E_ADMIN_A"),
    adminB: () => required("E2E_ADMIN_B"),
    viewerA: () => required("E2E_VIEWER_A"),
    engineerA: () => required("E2E_ENGINEER_A"),
    /** Tenant A engineer who still has the password an admin issued. */
    newcomerA: () => required("E2E_NEWCOMER_A"),
    newcomerPassword: () => required("E2E_NEWCOMER_PASSWORD"),
  },
  /** Tenant A missions, by the state the setup left them in. */
  missions: {
    awaitingApproval: () => required("E2E_MISSION_APPROVE"),
    awaitingRejection: () => required("E2E_MISSION_REJECT"),
    viewed: () => required("E2E_MISSION_VIEWED"),
    hostile: () => required("E2E_MISSION_HOSTILE"),
    accepted: () => required("E2E_MISSION_ACCEPTED"),
    draft: () => required("E2E_MISSION_DRAFT"),
  },
  /** Title of tenant A's hostile mission (markup that must stay text). */
  hostileTitle: '<img src=x onerror="window.__xss=1">E2E hostile',
} as const;

/** Logs in through the login page and waits for the page it leads to. */
export async function logIn(page: Page, email: string, password = fixtures.password()) {
  await page.goto(`${fixtures.web}/login`);
  await page.getByLabel("メールアドレス").fill(email);
  await page.getByLabel("パスワード").fill(password);
  await page.getByRole("button", { name: "ログインする", exact: true }).click();
  await expect(page).not.toHaveURL(/\/login/);
}
