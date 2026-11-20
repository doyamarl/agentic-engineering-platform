import { describe, expect, it } from "vitest";
import { anthropicModel } from "./anthropic-model.ts";

// Calls the real Anthropic API and costs money (well under USD 0.01 per run). Skipped unless the
// operator opts in from their own terminal:
//
//   AEP_LIVE_ANTHROPIC=1 ANTHROPIC_API_KEY=... mise exec -- pnpm exec vitest run \
//     adapters/models/anthropic/src/anthropic-model.live.test.ts
//
// AEP_LIVE_ANTHROPIC_MODEL overrides the model (default claude-sonnet-5-5).

const apiKey = process.env["ANTHROPIC_API_KEY"] ?? "";
const enabled = process.env["AEP_LIVE_ANTHROPIC"] === "1" && apiKey !== "";
const model = process.env["AEP_LIVE_ANTHROPIC_MODEL"] ?? "claude-sonnet-5-5";

describe.skipIf(!enabled)("anthropicModel against the real API", () => {
  it("streams a short reply and finishes", async () => {
    const port = anthropicModel({ apiKey, model, effort: "low", maxTokens: 2_000 });
    let text = "";
    let stopReason = "";
    let deltas = 0;
    for await (const event of port.stream(
      { messages: [{ role: "user", content: "Reply with the single word: pong" }] },
      AbortSignal.timeout(60_000),
    )) {
      if (event.type === "text_delta") {
        text += event.text;
        deltas += 1;
      }
      if (event.type === "finished") stopReason = event.stopReason;
    }
    expect(deltas).toBeGreaterThan(0);
    expect(text.toLowerCase()).toContain("pong");
    expect(stopReason).toBe("end_turn");
  }, 90_000);
});
