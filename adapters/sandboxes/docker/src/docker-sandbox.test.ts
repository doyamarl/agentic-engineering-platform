import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxHandle, SandboxPort, SandboxSpec } from "@aep/application";
import type { MissionId, TenantId } from "@aep/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dockerSandbox, proxyRunArgs, runArgs } from "./docker-sandbox.ts";

// Integration tests against the local Docker daemon (also used by Testcontainers in this repo).
const IMAGE = "node:24-bookworm-slim";

const context = {
  tenantId: "0a000000-0000-4000-8000-000000000001" as TenantId,
  missionId: "0a000000-0000-4000-8000-0000000000c1" as MissionId,
};

const spec = (overrides: Partial<SandboxSpec> = {}): SandboxSpec => ({
  image: IMAGE,
  workdir: mkdtempSync(join(tmpdir(), "aep-sbx-test-")),
  network: { kind: "none" },
  limits: { memoryMb: 256, cpus: 1, pids: 64, ttlMs: 120_000 },
  ...overrides,
});

const sandbox = dockerSandbox();
const created: SandboxHandle[] = [];

// Pull outside the per-test timeout; CI starts without the image.
beforeAll(() => {
  if (spawnSync("docker", ["image", "inspect", IMAGE]).status !== 0) {
    const pull = spawnSync("docker", ["pull", "--quiet", IMAGE], { encoding: "utf8" });
    if (pull.status !== 0) throw new Error(`docker pull ${IMAGE} failed: ${pull.stderr}`);
  }
}, 300_000);

afterAll(async () => {
  await Promise.all(created.map((h) => sandbox.destroy(h)));
});

async function create(s: SandboxSpec = spec()) {
  const handle = await sandbox.create(s, context);
  created.push(handle);
  return { handle, spec: s };
}

/** Runs `sh -c script` in the sandbox and returns its exit code and stdout. */
function sh(
  port: SandboxPort,
  handle: SandboxHandle,
  script: string,
  env: Record<string, string> = {},
  stdin = "",
): Promise<{ code: number | null; out: string }> {
  const p = port.spawn(handle, { command: "sh", args: ["-c", script], env });
  let out = "";
  p.stdout.setEncoding("utf8");
  p.stdout.on("data", (chunk: string) => (out += chunk));
  p.stdin.end(stdin);
  return new Promise((resolve, reject) => {
    p.once("error", reject);
    p.once("exit", (code) => {
      resolve({ code, out });
    });
  });
}

function inspect(id: string, format: string): string {
  return spawnSync("docker", ["inspect", "--format", format, id], {
    encoding: "utf8",
  }).stdout.trim();
}

describe("runArgs", () => {
  const base = { user: "1000:1000", tmpfsMb: 64 };

  it("rejects relative or comma-containing workdirs and root", () => {
    expect(() => runArgs("n", spec({ workdir: "rel/dir" }), context, base)).toThrow(/absolute/);
    expect(() => runArgs("n", spec({ workdir: "/a,readonly=false" }), context, base)).toThrow(
      /comma/,
    );
    expect(() => runArgs("n", spec(), context, { ...base, user: "0:0" })).toThrow(/root/);
    expect(() => runArgs("n", spec(), context, { ...base, user: "node" })).toThrow(/numeric/);
  });

  it("never mounts the Docker socket and runs sleep as the entrypoint with the TTL", () => {
    const args = runArgs("n", spec({ limits: { ...spec().limits, ttlMs: 1500 } }), context, base);
    expect(args.join(" ")).not.toContain("docker.sock");
    expect(args.slice(-2)).toEqual([IMAGE, "2"]);
    expect(args[args.indexOf("--entrypoint") + 1]).toBe("sleep");
  });

  it("mounts extra host paths read-only, never over the checkout or home", () => {
    const mount = (target: string) =>
      runArgs("n", spec({ readOnlyMounts: [{ source: "/opt/tool", target }] }), context, base);
    expect(mount("/opt/aep/tool")).toContain(
      "type=bind,source=/opt/tool,target=/opt/aep/tool,readonly",
    );
    for (const bad of ["/workspace", "/workspace/x", "/home/sandbox/.x", "rel"]) {
      expect(() => mount(bad)).toThrow(/read-only mount target/);
    }
  });

  it("rejects an empty or malformed allowlist", () => {
    const allow = (hosts: string[]) => spec({ network: { kind: "allowlist", hosts } });
    expect(() => runArgs("n", allow([]), context, base)).toThrow(/at least one/);
    for (const bad of ["a,b.com", "Upper.com", "*.npmjs.org", "x.com:443", "-x.com"]) {
      expect(() => runArgs("n", allow([bad]), context, base)).toThrow(/invalid allowlist host/);
    }
  });

  it("puts an allowlist sandbox on its internal network only, with proxy settings", () => {
    const s = spec({ network: { kind: "allowlist", hosts: ["registry.npmjs.org"] } });
    const args = runArgs("n", s, context, base);
    expect(args.filter((a) => a === "--network")).toHaveLength(1);
    expect(args[args.indexOf("--network") + 1]).toBe("n-net");
    expect(args).toContain("HTTPS_PROXY=http://aep-egress:3128");
  });

  it("hardens the proxy container like the sandbox", () => {
    const s = spec({ network: { kind: "allowlist", hosts: ["registry.npmjs.org"] } });
    const args = proxyRunArgs("n", s, context, { ...base, image: IMAGE, script: "/x/p.ts" });
    for (const flag of ["--read-only", "--rm", "--init"]) expect(args).toContain(flag);
    expect(args[args.indexOf("--cap-drop") + 1]).toBe("ALL");
    expect(args[args.indexOf("--security-opt") + 1]).toBe("no-new-privileges");
    expect(args[args.indexOf("--user") + 1]).toBe("1000:1000");
    expect(args.join(" ")).not.toContain("docker.sock");
    expect(args).toContain("AEP_EGRESS_HOSTS=registry.npmjs.org");
  });
});

describe("dockerSandbox (Docker daemon)", () => {
  it("runs as the host user, non-root, without capabilities or new privileges", async () => {
    const { handle } = await create();
    const { out } = await sh(
      sandbox,
      handle,
      // CapEff is 0 for any non-root user; CapBnd shows that --cap-drop ALL emptied the bounding set.
      "id -u; grep -E '^(CapEff|CapBnd|NoNewPrivs):' /proc/self/status",
    );
    const [uid, capEff, capBnd, noNewPrivs] = out.trim().split("\n");
    expect(uid).toBe(String(process.getuid?.()));
    expect(uid).not.toBe("0");
    expect(capEff).toMatch(/^CapEff:\s+0+$/);
    expect(capBnd).toMatch(/^CapBnd:\s+0+$/);
    expect(noNewPrivs).toMatch(/^NoNewPrivs:\s+1$/);
  });

  it("can write only the checkout, /tmp and its home; the root filesystem is read-only", async () => {
    const { handle, spec: s } = await create();
    const { out } = await sh(
      sandbox,
      handle,
      [
        "echo from-sandbox > /workspace/out.txt && echo workspace-ok",
        "touch /tmp/x && echo tmp-ok",
        'touch "$HOME/x" && echo home-ok',
        "touch /etc/x 2>/dev/null || echo etc-denied",
        // /var/tmp is world-writable (1777) in the image, so only --read-only denies it.
        "touch /var/tmp/x 2>/dev/null || echo var-tmp-denied",
      ].join("; "),
      { HOME: "/home/sandbox" },
    );
    expect(out.trim().split("\n")).toEqual([
      "workspace-ok",
      "tmp-ok",
      "home-ok",
      "etc-denied",
      "var-tmp-denied",
    ]);
    expect(readFileSync(join(s.workdir, "out.txt"), "utf8")).toBe("from-sandbox\n");
  });

  it("sees the checkout but no other host path and no Docker socket", async () => {
    const s = spec();
    writeFileSync(join(s.workdir, "in.txt"), "from-host");
    const { handle } = await create(s);
    const { out } = await sh(
      sandbox,
      handle,
      "cat /workspace/in.txt; echo; test -e /var/run/docker.sock && echo SOCKET || echo no-socket; grep -c ' /workspace ' /proc/mounts",
    );
    expect(out.trim().split("\n")).toEqual(["from-host", "no-socket", "1"]);
  });

  it("can read but not write a read-only mount", async () => {
    const tool = mkdtempSync(join(tmpdir(), "aep-sbx-tool-"));
    writeFileSync(join(tool, "t.txt"), "tool");
    const { handle } = await create(spec({ readOnlyMounts: [{ source: tool, target: "/opt/t" }] }));
    const { out } = await sh(
      sandbox,
      handle,
      "cat /opt/t/t.txt; echo; touch /opt/t/x 2>/dev/null || echo denied",
    );
    expect(out.trim().split("\n")).toEqual(["tool", "denied"]);
  });

  it("has no network", async () => {
    const { handle } = await create();
    const { out } = await sh(sandbox, handle, "ls /sys/class/net | sort | tr '\\n' ' '");
    expect(out.trim()).toBe("lo");
  });

  it("applies memory, CPU and process limits, and labels the tenant and mission", async () => {
    const { handle } = await create();
    expect(
      inspect(
        handle.id,
        "{{.HostConfig.Memory}} {{.HostConfig.NanoCpus}} {{.HostConfig.PidsLimit}}",
      ),
    ).toBe(`${String(256 * 1024 * 1024)} 1000000000 64`);
    expect(
      inspect(
        handle.id,
        '{{index .Config.Labels "aep.tenant"}} {{index .Config.Labels "aep.mission"}}',
      ),
    ).toBe(`${context.tenantId} ${context.missionId}`);
  });

  it("passes only the given environment, without putting values on the command line", async () => {
    const { handle } = await create();
    const p = sandbox.spawn(handle, {
      command: "sh",
      args: ["-c", "env | sort; sleep 5"],
      env: { SECRET_TOKEN: "s3cret-value", HOME: "/home/sandbox" },
    });
    let out = "";
    p.stdout.setEncoding("utf8");
    p.stdout.on("data", (c: string) => (out += c));
    p.stdin.end();
    await new Promise((r) => setTimeout(r, 1000));
    const hostPs = spawnSync("ps", ["-eo", "args"], { encoding: "utf8" }).stdout;
    p.kill("SIGKILL");
    await new Promise((r) => p.once("exit", r));
    expect(hostPs).toContain(handle.id);
    expect(hostPs).not.toContain("s3cret-value");
    expect(out).toContain("SECRET_TOKEN=s3cret-value");
    expect(out).not.toMatch(/DOCKER_|ANTHROPIC_API_KEY|DATABASE_URL/);
  });

  it("rejects invalid or reserved env names", async () => {
    const { handle } = await create();
    expect(() => sandbox.spawn(handle, { command: "true", args: [], env: { "A=B": "x" } })).toThrow(
      /invalid/,
    );
    expect(() =>
      sandbox.spawn(handle, { command: "true", args: [], env: { DOCKER_HOST: "tcp://x" } }),
    ).toThrow(/reserved/);
  });

  it("streams stdin to stdout", async () => {
    const { handle } = await create();
    expect(await sh(sandbox, handle, "cat", {}, "hello\n")).toEqual({ code: 0, out: "hello\n" });
  });

  it("removes itself when the TTL ends, and destroy is idempotent", async () => {
    const { handle } = await create(spec({ limits: { ...spec().limits, ttlMs: 1000 } }));
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && inspect(handle.id, "{{.State.Status}}") !== "") {
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(inspect(handle.id, "{{.State.Status}}")).toBe("");
    await sandbox.destroy(handle);
  }, 20_000);

  describe("allowlist network", () => {
    // Needs internet access from the Docker host (true on CI runners).
    const allowSpec = () => spec({ network: { kind: "allowlist", hosts: ["registry.npmjs.org"] } });

    /** Node one-liner run in the sandbox; prints a single result word. */
    const node = (handle: SandboxHandle, code: string) =>
      sh(sandbox, handle, `node -e '${code}'`, {
        HOME: "/home/sandbox",
        PATH: "/usr/local/bin:/usr/bin:/bin",
      });

    it("reaches an allowlisted host over HTTPS through the proxy", async () => {
      const { handle } = await create(allowSpec());
      const { out } = await node(
        handle,
        'fetch("https://registry.npmjs.org/-/ping").then(r => console.log(r.status), e => console.log("error", e.cause?.code ?? e.message))',
      );
      expect(out.trim()).toBe("200");
    }, 30_000);

    it("cannot reach other hosts, resolve names, or connect around the proxy", async () => {
      const { handle } = await create(allowSpec());
      const other = await node(
        handle,
        'fetch("https://example.com/").then(r => console.log("reached", r.status), () => console.log("blocked"))',
      );
      expect(other.out.trim()).toBe("blocked");
      const dns = await sh(sandbox, handle, "getent hosts registry.npmjs.org || echo no-dns");
      expect(dns.out.trim()).toBe("no-dns");
      // 1.1.1.1:443 is reachable from any host with internet; only the network setup blocks it.
      const direct = await node(
        handle,
        'const s = require("net").connect(443, "1.1.1.1"); s.setTimeout(5000, () => { console.log("blocked"); process.exit() }); s.on("connect", () => { console.log("connected"); process.exit() }); s.on("error", () => console.log("blocked"))',
      );
      expect(direct.out.trim()).toBe("blocked");
    }, 30_000);

    it("destroy removes the sandbox, its proxy and its network", async () => {
      const { handle } = await create(allowSpec());
      expect(inspect(`${handle.id}-proxy`, "{{.State.Status}}")).toBe("running");
      await sandbox.destroy(handle);
      expect(inspect(handle.id, "{{.State.Status}}")).toBe("");
      expect(inspect(`${handle.id}-proxy`, "{{.State.Status}}")).toBe("");
      expect(spawnSync("docker", ["network", "inspect", `${handle.id}-net`]).status).not.toBe(0);
    });
  });

  it("destroys a running sandbox", async () => {
    const { handle } = await create();
    await sandbox.destroy(handle);
    expect(inspect(handle.id, "{{.State.Status}}")).toBe("");
  });
});
