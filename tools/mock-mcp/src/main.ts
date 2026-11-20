import { startMockMcp } from "./server.ts";

// Entry point for the e2e stack: MOCK_MCP_PORT (default 8090), MOCK_MCP_PUBLIC_URL (the URL the
// web browser and the worker use, e.g. http://mock-mcp:8090).
const port = Number(process.env["MOCK_MCP_PORT"] ?? "8090");
const publicUrl = process.env["MOCK_MCP_PUBLIC_URL"];
const mock = await startMockMcp({
  port,
  host: "0.0.0.0",
  ...(publicUrl === undefined ? {} : { publicUrl }),
});
console.log(JSON.stringify({ msg: "mock MCP server listening", url: mock.url }));
const stop = () => void mock.close().then(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
