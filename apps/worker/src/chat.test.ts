import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { chatModel } from "./chat.ts";

describe("chatModel", () => {
  it("uses claude-sonnet-5-5 on the Anthropic API by default", () => {
    expect(chatModel({ ANTHROPIC_API_KEY: "sk-ant-test" })).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-5-5",
    });
  });

  it("stays disabled without an API key", () => {
    expect(chatModel({})).toEqual({ missing: ["ANTHROPIC_API_KEY"] });
  });

  it("runs the fake model without a key", () => {
    expect(chatModel({ AEP_MODEL_PROVIDER: "fake" })).toMatchObject({ provider: "fake" });
  });

  it.each([
    [{ AEP_MODEL_BASE_URL: "https://proxy.example.com" }, /not allowed/],
    [{ AEP_MODEL_PROVIDER: "ollama" }, /not allowed/],
    [{ AEP_CHAT_EFFORT: "extreme" }, /AEP_CHAT_EFFORT/],
    [{ AEP_MODEL_PROVIDER: "fake", AEP_FAKE_MODEL_DELAY_MS: "-1" }, /DELAY/],
  ])("refuses %j", (env, reason) => {
    expect(() => chatModel({ ANTHROPIC_API_KEY: "sk-ant-test", ...env })).toThrow(reason);
  });
});

describe("the worker process", () => {
  it("refuses to start with a model endpoint off the allowlist", async () => {
    const main = fileURLToPath(new URL("./main.ts", import.meta.url));
    const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      execFile(
        process.execPath,
        [main],
        {
          env: {
            PATH: process.env["PATH"] ?? "",
            ANTHROPIC_API_KEY: "sk-ant-test",
            AEP_MODEL_BASE_URL: "https://proxy.example.com",
            // Unreachable on purpose: the check must come before any connection.
            DATABASE_URL: "postgres://nobody@127.0.0.1:1/none",
          },
          timeout: 20_000,
        },
        (error, _stdout, stderr) => {
          resolve({ code: error === null ? 0 : (error.code as number | null), stderr });
        },
      );
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("https://proxy.example.com is not allowed");
  }, 30_000);
});
