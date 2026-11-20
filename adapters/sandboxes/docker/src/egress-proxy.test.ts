import { once } from "node:events";
import { connect, createServer, type AddressInfo, type Server } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { allowedTarget, createEgressProxy, type EgressDecision } from "./egress-proxy.ts";

describe("allowedTarget", () => {
  const hosts = ["api.anthropic.com"];
  const ports = [443];

  it("allows only an exact host and port", () => {
    expect(allowedTarget("api.anthropic.com:443", hosts, ports)).toEqual({
      host: "api.anthropic.com",
      port: 443,
    });
    expect(allowedTarget("API.Anthropic.com:443", hosts, ports)).toBeDefined();
    expect(allowedTarget("api.anthropic.com:80", hosts, ports)).toBeUndefined();
    expect(allowedTarget("api.anthropic.com", hosts, ports)).toBeUndefined();
    expect(allowedTarget("evil.api.anthropic.com:443", hosts, ports)).toBeUndefined();
    expect(allowedTarget("api.anthropic.com.evil.test:443", hosts, ports)).toBeUndefined();
  });

  it("rejects authorities that carry more than host:port", () => {
    expect(allowedTarget("x@api.anthropic.com:443", hosts, ports)).toBeUndefined();
    expect(allowedTarget("api.anthropic.com:443/path", hosts, ports)).toBeUndefined();
    expect(allowedTarget("api.anthropic.com:0443", hosts, ports)).toBeUndefined();
    expect(allowedTarget("[::1]:443", hosts, ports)).toBeUndefined();
    expect(allowedTarget("", hosts, ports)).toBeUndefined();
  });
});

describe("createEgressProxy", () => {
  let echo: Server;
  let proxy: Server;
  let echoPort: number;
  let proxyPort: number;
  const decisions: EgressDecision[] = [];

  beforeAll(async () => {
    echo = createServer((s) => s.pipe(s));
    echo.listen(0, "127.0.0.1");
    await once(echo, "listening");
    echoPort = (echo.address() as AddressInfo).port;
    proxy = createEgressProxy({
      hosts: ["127.0.0.1"],
      ports: [echoPort],
      onDecision: (d) => decisions.push(d),
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    proxyPort = (proxy.address() as AddressInfo).port;
  });

  afterAll(() => {
    proxy.close();
    echo.close();
  });

  /** Sends `request` to the proxy and returns everything it answers until it closes or `until`. */
  function exchange(request: string, until?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = connect(proxyPort, "127.0.0.1", () => socket.write(request));
      let data = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        data += chunk;
        if (until !== undefined && data.includes(until)) {
          socket.destroy();
          resolve(data);
        }
      });
      socket.on("close", () => {
        resolve(data);
      });
      socket.on("error", reject);
    });
  }

  it("tunnels to an allowed host and port, including bytes sent with the request", async () => {
    const reply = await exchange(
      `CONNECT 127.0.0.1:${String(echoPort)} HTTP/1.1\r\nHost: x\r\n\r\nping`,
      "ping",
    );
    expect(reply).toBe("HTTP/1.1 200 Connection Established\r\n\r\nping");
    expect(decisions).toContainEqual({ allowed: true, authority: `127.0.0.1:${String(echoPort)}` });
  });

  it("refuses other hosts and ports", async () => {
    expect(await exchange("CONNECT localhost:" + String(echoPort) + " HTTP/1.1\r\n\r\n")).toMatch(
      /^HTTP\/1.1 403/,
    );
    expect(await exchange(`CONNECT 127.0.0.1:${String(proxyPort)} HTTP/1.1\r\n\r\n`)).toMatch(
      /^HTTP\/1.1 403/,
    );
    expect(decisions.filter((d) => !d.allowed)).toHaveLength(2);
  });

  it("refuses plain HTTP requests", async () => {
    expect(
      await exchange(`GET http://127.0.0.1:${String(echoPort)}/ HTTP/1.1\r\nHost: x\r\n\r\n`),
    ).toMatch(/^HTTP\/1.1 403/);
  });
});
