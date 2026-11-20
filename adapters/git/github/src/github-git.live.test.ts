import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gitHubApp } from "./github-app.ts";
import { gitHubGit } from "./github-git.ts";

// Uses a real GitHub App against a real repository: checkout, push a branch, open a draft pull
// request, then close it and delete the branch. Skipped unless the operator opts in from their
// own terminal:
//
//   AEP_LIVE_GITHUB=1 AEP_GITHUB_APP_ID=... AEP_GITHUB_PRIVATE_KEY_PATH=... \
//   AEP_GITHUB_TEST_REPO=owner/name mise exec -- pnpm exec vitest run \
//     adapters/git/github/src/github-git.live.test.ts
//
// AEP_GITHUB_TEST_BASE overrides the base branch (default main).

const env = process.env;
const enabled = env["AEP_LIVE_GITHUB"] === "1";
const [owner = "", name = ""] = (env["AEP_GITHUB_TEST_REPO"] ?? "").split("/");

describe.skipIf(!enabled)("gitHubGit against GitHub", () => {
  it("checks out, pushes a mission branch and opens a draft pull request", async () => {
    const app = gitHubApp({
      appId: env["AEP_GITHUB_APP_ID"] ?? "",
      privateKey: readFileSync(env["AEP_GITHUB_PRIVATE_KEY_PATH"] ?? "", "utf8"),
    });
    const port = gitHubGit({
      app,
      committer: { name: "aep-live-test", email: "aep-live-test@users.noreply.github.com" },
    });
    const repository = { owner, name };
    const branch = `aep/live-test-${String(Date.now())}`;
    const checkout = await port.checkout(
      repository,
      env["AEP_GITHUB_TEST_BASE"] ?? "main",
      join(mkdtempSync(join(tmpdir(), "aep-github-live-")), "c"),
    );
    writeFileSync(join(checkout.workTree, "aep-live-test.txt"), `${branch}\n`);
    const published = await port.publish(checkout, { branch, message: "test: AEP live test" });
    expect(published.kind).toBe("pushed");

    const request = { branch, title: "AEP live test (will be closed)", body: "Automated test." };
    const pr = await port.openDraftPullRequest(checkout, request);
    const { token } = await app.installationToken(repository);
    const repo = `/repos/${owner}/${name}`;
    try {
      expect(pr.created).toBe(true);
      const fetched = await app.request("GET", `${repo}/pulls/${String(pr.number)}`, token);
      const pull = fetched.data as { draft: boolean; head: { sha: string } };
      expect(pull.draft).toBe(true);
      expect(published.kind === "pushed" && pull.head.sha).toBe(
        published.kind === "pushed" ? published.sha : "",
      );
      expect(await port.openDraftPullRequest(checkout, request)).toEqual({ ...pr, created: false });
    } finally {
      await app.request("PATCH", `${repo}/pulls/${String(pr.number)}`, token, { state: "closed" });
      await app.request("DELETE", `${repo}/git/refs/heads/${branch}`, token);
    }
  }, 120_000);
});
