import { describe, expect, it } from "vitest";
import { modelEndpointProblem } from "./model-endpoints.ts";

describe("modelEndpointProblem", () => {
  it.each([
    [{ provider: "anthropic" }],
    [{ provider: "anthropic", baseUrl: "https://api.anthropic.com" }],
    [{ provider: "anthropic", baseUrl: "https://api.anthropic.com/" }],
    [{ provider: "fake" }],
  ])("allows %j", (endpoint) => {
    expect(modelEndpointProblem(endpoint)).toBeUndefined();
  });

  it.each([
    ["an unknown provider", { provider: "ollama" }, /not allowed/],
    [
      "another host",
      { provider: "anthropic", baseUrl: "https://proxy.example.com" },
      /not allowed/,
    ],
    ["plain HTTP", { provider: "anthropic", baseUrl: "http://api.anthropic.com" }, /not allowed/],
    [
      "a look-alike host",
      { provider: "anthropic", baseUrl: "https://api.anthropic.com.evil.example" },
      /not allowed/,
    ],
    [
      "a path",
      { provider: "anthropic", baseUrl: "https://api.anthropic.com/proxy" },
      /without a path/,
    ],
    [
      "credentials",
      { provider: "anthropic", baseUrl: "https://u:p@api.anthropic.com" },
      /without a path/,
    ],
    [
      "a URL for the fake model",
      { provider: "fake", baseUrl: "https://api.anthropic.com" },
      /not allowed/,
    ],
    ["no URL at all", { provider: "anthropic", baseUrl: "api.anthropic.com" }, /not a URL/],
  ])("refuses %s", (_, endpoint, reason) => {
    expect(modelEndpointProblem(endpoint)).toMatch(reason);
  });
});
