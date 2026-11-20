import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { gitHubApp } from "./github-app.ts";
import { gitHubCodeReader } from "./github-code.ts";

// Reads a real repository through a real GitHub App: the root directory, one file and a search.
// Skipped unless the operator opts in from their own terminal, with the same variables as
// github-git.live.test.ts:
//
//   AEP_LIVE_GITHUB=1 AEP_GITHUB_APP_ID=... AEP_GITHUB_PRIVATE_KEY_PATH=... \
//   AEP_GITHUB_TEST_REPO=owner/name mise exec -- pnpm exec vitest run \
//     adapters/git/github/src/github-code.live.test.ts
//
// AEP_GITHUB_TEST_FILE names the file to read (default README.md) and AEP_GITHUB_TEST_QUERY the
// search terms (default the first word of that file).

const env = process.env;
const enabled = env["AEP_LIVE_GITHUB"] === "1";
const [owner = "", name = ""] = (env["AEP_GITHUB_TEST_REPO"] ?? "").split("/");

describe.skipIf(!enabled)("gitHubCodeReader against GitHub", () => {
  it("lists the root, reads a file and searches the repository", async () => {
    const reader = gitHubCodeReader({
      app: gitHubApp({
        appId: env["AEP_GITHUB_APP_ID"] ?? "",
        privateKey: readFileSync(env["AEP_GITHUB_PRIVATE_KEY_PATH"] ?? "", "utf8"),
      }),
    });
    const repository = { owner, name };
    const signal = AbortSignal.timeout(60_000);
    const file = env["AEP_GITHUB_TEST_FILE"] ?? "README.md";

    const root = await reader.readPath(repository, { path: "" }, signal);
    expect(root.kind).toBe("directory");

    const read = await reader.readPath(repository, { path: file }, signal);
    expect(read.kind).toBe("file");
    const text = read.kind === "file" ? read.text : "";

    const query = env["AEP_GITHUB_TEST_QUERY"] ?? text.match(/[A-Za-z]{4,}/)?.[0] ?? "the";
    const found = await reader.search(repository, query, signal);
    expect(found.total).toBeGreaterThanOrEqual(0);
  }, 90_000);
});
