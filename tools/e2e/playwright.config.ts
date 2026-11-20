import { defineConfig, devices } from "@playwright/test";

// Browser tests against a running Compose stack prepared by infra/compose/e2e.sh, which creates
// the accounts the tests log in as and passes them and the fixture ids through the environment
// (see src/fixtures.ts).

export default defineConfig({
  testDir: "src",
  testMatch: "*.spec.ts",
  // The tests change shared missions in the stack; run them one at a time.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 30_000,
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    locale: "ja-JP",
    // The OIDC provider of compose.e2e.yaml is "oidc" inside the stack; the browser must reach it
    // under the same name, so the issuer matches.
    launchOptions: { args: ["--host-resolver-rules=MAP oidc 127.0.0.1"] },
    trace: "retain-on-failure",
  },
});
