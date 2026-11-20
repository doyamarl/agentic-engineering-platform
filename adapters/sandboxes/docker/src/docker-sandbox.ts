import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SANDBOX_HOME,
  SANDBOX_WORKDIR,
  type ExecutionContext,
  type SandboxCommand,
  type SandboxHandle,
  type SandboxNetwork,
  type SandboxPort,
  type SandboxProcess,
  type SandboxSpec,
} from "@aep/application";

// SandboxPort on the Docker CLI (T0/T1 only, ADR §7). Each sandbox is a container whose main
// process is `sleep <ttl>` under --rm, so Docker itself removes it when the TTL ends, even if the
// worker that created it has crashed. Commands are argument arrays, never shell strings.
//
// An allowlist network is three objects named after the sandbox: an internal network `<name>-net`
// (no route out, no external DNS), the sandbox on it, and a proxy container `<name>-proxy` on it
// and on the egress network, which forwards CONNECT tunnels to allowlisted hosts only. The proxy
// exits with the sandbox's TTL; the network stays until destroy() removes it.

export type DockerSandboxConfig = {
  /** Docker CLI. Defaults to `docker` resolved on the host PATH once, at construction. */
  readonly docker?: string;
  /** uid:gid inside the container. Defaults to the current host user, who owns the checkout. */
  readonly user?: string;
  /** Size of each tmpfs (/tmp and SANDBOX_HOME). */
  readonly tmpfsMb?: number;
  /** Image with Node 24 that runs the egress proxy. Pin it by digest in production. */
  readonly proxyImage?: string;
  /** Docker network that gives the egress proxy its route out. Defaults to `bridge`. */
  readonly egressNetwork?: string;
};

const PROXY_ALIAS = "aep-egress";
const PROXY_PORT = 3128;
const PROXY_SCRIPT = "/opt/aep/egress-proxy.ts";
const HOST_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** Environment that points HTTP clients in the sandbox at the egress proxy. */
const PROXY_ENV: Readonly<Record<string, string>> = (() => {
  const url = `http://${PROXY_ALIAS}:${String(PROXY_PORT)}`;
  return {
    HTTPS_PROXY: url,
    https_proxy: url,
    HTTP_PROXY: url,
    http_proxy: url,
    // Node's built-in fetch and https ignore the variables above unless this is set (Node >= 24.5).
    NODE_USE_ENV_PROXY: "1",
  };
})();

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Variables the Docker CLI itself needs to reach the daemon; never forwarded into the sandbox.
const DOCKER_CLI_ENV = [
  "PATH",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "DOCKER_CERT_PATH",
  "DOCKER_TLS_VERIFY",
];

export class DockerCommandError extends Error {
  readonly args: readonly string[];
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(args: readonly string[], exitCode: number | null, stderr: string) {
    super(`docker ${args[0] ?? ""} failed (exit ${String(exitCode)}): ${stderr.trim()}`);
    this.name = "DockerCommandError";
    this.args = args;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/** Absolute path of `name` on PATH, so a sandbox PATH passed to spawn cannot change it. */
function resolveOnPath(name: string): string {
  if (isAbsolute(name)) return name;
  for (const dir of (process.env["PATH"] ?? "").split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here
    }
  }
  throw new Error(`${name} not found on PATH`);
}

/** Rejects a mount source that --mount would misparse. */
function checkMountSource(path: string, what: string): void {
  if (!isAbsolute(path)) throw new Error(`${what} must be an absolute path`);
  // --mount uses commas as separators, so a comma would let a path add mount options.
  if (path.includes(",")) throw new Error(`${what} must not contain a comma`);
}

function readOnlyMountArgs(spec: SandboxSpec): string[] {
  return (spec.readOnlyMounts ?? []).flatMap(({ source, target }) => {
    checkMountSource(source, "read-only mount source");
    checkMountSource(target, "read-only mount target");
    for (const owned of [SANDBOX_WORKDIR, SANDBOX_HOME]) {
      if (target === owned || target.startsWith(`${owned}/`)) {
        throw new Error(`read-only mount target must not be under ${owned}`);
      }
    }
    return ["--mount", `type=bind,source=${source},target=${target},readonly`];
  });
}

function checkUser(user: string): void {
  if (!/^\d+:\d+$/.test(user)) throw new Error("sandbox user must be numeric uid:gid");
  if (user.startsWith("0:")) throw new Error("sandbox user must not be root");
}

function checkHosts(network: SandboxNetwork): void {
  if (network.kind !== "allowlist") return;
  if (network.hosts.length === 0) throw new Error("allowlist network needs at least one host");
  for (const h of network.hosts) {
    if (!HOST_NAME.test(h)) throw new Error(`invalid allowlist host: ${h}`);
  }
}

const labels = (context: ExecutionContext): string[] => [
  "--label",
  "aep.sandbox=1",
  "--label",
  `aep.tenant=${context.tenantId}`,
  "--label",
  `aep.mission=${context.missionId}`,
];

const ttlSeconds = (spec: SandboxSpec): string =>
  String(Math.max(1, Math.ceil(spec.limits.ttlMs / 1000)));

function defaultUser(): string {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) throw new Error("set DockerSandboxConfig.user");
  return `${String(uid)}:${String(gid)}`;
}

/** Arguments for `docker run`, exported so the hardening flags are unit-tested. */
export function runArgs(
  name: string,
  spec: SandboxSpec,
  context: ExecutionContext,
  options: { readonly user: string; readonly tmpfsMb: number },
): string[] {
  checkMountSource(spec.workdir, "sandbox workdir");
  checkUser(options.user);
  checkHosts(spec.network);
  const { memoryMb, cpus, pids } = spec.limits;
  const [uid = "", gid = ""] = options.user.split(":");
  const size = `size=${String(options.tmpfsMb)}m`;
  return [
    "run",
    "--detach",
    "--rm",
    "--init",
    "--name",
    name,
    "--user",
    options.user,
    "--read-only",
    "--tmpfs",
    `/tmp:rw,nosuid,nodev,mode=1777,${size}`,
    "--tmpfs",
    `${SANDBOX_HOME}:rw,nosuid,nodev,mode=0700,uid=${uid},gid=${gid},${size}`,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    String(pids),
    "--memory",
    `${String(memoryMb)}m`,
    "--memory-swap",
    `${String(memoryMb)}m`,
    "--cpus",
    String(cpus),
    ...(spec.network.kind === "none"
      ? ["--network", "none"]
      : [
          "--network",
          `${name}-net`,
          ...Object.entries(PROXY_ENV).flatMap(([k, v]) => ["--env", `${k}=${v}`]),
        ]),
    "--mount",
    `type=bind,source=${spec.workdir},target=${SANDBOX_WORKDIR}`,
    ...readOnlyMountArgs(spec),
    "--workdir",
    SANDBOX_WORKDIR,
    ...labels(context),
    "--entrypoint",
    "sleep",
    spec.image,
    ttlSeconds(spec),
  ];
}

/** Arguments for `docker run` of the egress proxy of sandbox `name` (allowlist networks only). */
export function proxyRunArgs(
  name: string,
  spec: SandboxSpec,
  context: ExecutionContext,
  options: { readonly user: string; readonly image: string; readonly script: string },
): string[] {
  if (spec.network.kind !== "allowlist") throw new Error("proxy is only for allowlist networks");
  checkUser(options.user);
  checkHosts(spec.network);
  checkMountSource(options.script, "proxy script");
  return [
    "run",
    "--detach",
    "--rm",
    "--init",
    "--name",
    `${name}-proxy`,
    "--user",
    options.user,
    "--read-only",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,mode=1777,size=16m",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "64",
    "--memory",
    "128m",
    "--memory-swap",
    "128m",
    "--cpus",
    "0.5",
    "--network",
    `${name}-net`,
    "--network-alias",
    PROXY_ALIAS,
    "--mount",
    `type=bind,source=${options.script},target=${PROXY_SCRIPT},readonly`,
    "--env",
    "AEP_EGRESS_PROXY_MAIN=1",
    "--env",
    `AEP_EGRESS_HOSTS=${spec.network.hosts.join(",")}`,
    "--env",
    `AEP_EGRESS_PORT=${String(PROXY_PORT)}`,
    "--env",
    `AEP_EGRESS_TTL_SEC=${ttlSeconds(spec)}`,
    ...labels(context),
    "--entrypoint",
    "node",
    options.image,
    PROXY_SCRIPT,
  ];
}

export function dockerSandbox(config: DockerSandboxConfig = {}): SandboxPort {
  const docker = resolveOnPath(config.docker ?? "docker");
  const user = config.user ?? defaultUser();
  const tmpfsMb = config.tmpfsMb ?? 512;
  const proxyImage = config.proxyImage ?? "node:24-bookworm-slim";
  const egressNetwork = config.egressNetwork ?? "bridge";
  const script = fileURLToPath(new URL("./egress-proxy.ts", import.meta.url));
  const cliEnv: Record<string, string> = {};
  for (const name of DOCKER_CLI_ENV) {
    const value = process.env[name];
    if (value !== undefined) cliEnv[name] = value;
  }
  // The CLI reads its config (contexts, credentials) from $HOME/.docker unless DOCKER_CONFIG says
  // otherwise; pin it so a sandbox HOME passed through exec does not redirect the CLI.
  cliEnv["DOCKER_CONFIG"] ??= join(homedir(), ".docker");

  const run = (args: string[]): string => {
    const r = spawnSync(docker, args, { encoding: "utf8", env: cliEnv });
    if (r.error) throw r.error;
    if (r.status !== 0) throw new DockerCommandError(args, r.status, r.stderr);
    return r.stdout;
  };

  /** Removes the sandbox and, if present, its proxy and network; missing objects are fine. */
  const removeAll = (name: string): void => {
    const ignoreMissing = (args: string[], missing: RegExp) => {
      try {
        run(args);
      } catch (error) {
        if (!(error instanceof DockerCommandError && missing.test(error.stderr))) throw error;
      }
    };
    ignoreMissing(["rm", "--force", name], /No such container/i);
    ignoreMissing(["rm", "--force", `${name}-proxy`], /No such container/i);
    ignoreMissing(["network", "rm", `${name}-net`], /not found|No such network/i);
  };

  return {
    create(spec, context) {
      const name = `aep-sbx-${randomUUID()}`;
      // Validate before creating anything, so a bad spec leaves nothing behind.
      const args = runArgs(name, spec, context, { user, tmpfsMb });
      try {
        if (spec.network.kind === "allowlist") {
          const proxyArgs = proxyRunArgs(name, spec, context, { user, image: proxyImage, script });
          run(["network", "create", "--internal", ...labels(context), `${name}-net`]);
          run(proxyArgs);
          run(["network", "connect", egressNetwork, `${name}-proxy`]);
        }
        run(args);
      } catch (error) {
        try {
          removeAll(name);
        } catch {
          // Report the creation error; leftovers carry the aep.sandbox label.
        }
        throw error;
      }
      return Promise.resolve({ id: name });
    },

    spawn(handle: SandboxHandle, command: SandboxCommand): SandboxProcess {
      const names = Object.keys(command.env);
      for (const n of names) {
        if (!ENV_NAME.test(n)) throw new Error(`invalid env name: ${n}`);
        if (n !== "PATH" && DOCKER_CLI_ENV.includes(n)) throw new Error(`reserved env name: ${n}`);
      }
      // `-e NAME` without a value makes the CLI read NAME from its own environment, so values
      // (API keys) never appear in the host's process list.
      const args = [
        "exec",
        "--interactive",
        "--workdir",
        command.cwd ?? SANDBOX_WORKDIR,
        ...names.flatMap((n) => ["--env", n]),
        handle.id,
        command.command,
        ...command.args,
      ];
      return spawn(docker, args, {
        env: { ...cliEnv, ...command.env, DOCKER_CONFIG: cliEnv["DOCKER_CONFIG"] },
        stdio: ["pipe", "pipe", "ignore"],
      });
    },

    destroy(handle) {
      removeAll(handle.id);
      return Promise.resolve();
    },
  };
}
