import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COMMON_SUFFIX, TASK_IDS, buildPrompt, taskPrompt } from "./tasks.ts";

const procedure = readFileSync(
  new URL("../../../docs/04_AGENT_BENCHMARK.md", import.meta.url),
  "utf8",
);

function quoteAfter(marker: string, from = 0): string {
  const start = procedure.indexOf(marker, from);
  if (start < 0) throw new Error(`marker not found: ${marker}`);
  const line = procedure
    .slice(start + marker.length)
    .split("\n")
    .find((l) => l.startsWith("> "));
  if (line === undefined) throw new Error(`no quote after: ${marker}`);
  return line.slice(2);
}

describe("benchmark prompts", () => {
  it("match the procedure document verbatim", () => {
    expect(COMMON_SUFFIX).toBe(quoteAfter("Common suffix appended to every prompt:"));
    for (const id of TASK_IDS) {
      const heading = procedure.indexOf(`### ${id} `);
      expect(heading, id).toBeGreaterThan(0);
      expect(taskPrompt(id), id).toBe(quoteAfter("Prompt:", heading));
    }
  });

  it("appends the common suffix to every task prompt", () => {
    expect(buildPrompt("B2")).toBe(`${taskPrompt("B2")}\n\n${COMMON_SUFFIX}`);
  });
});
