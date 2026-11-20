import type { Readable, Writable } from "node:stream";
import type { ExecutionContext } from "../agents/agent-port.ts";

// Isolated execution for agent work (docs/02_ARCHITECTURE_ADR.md §5, §7). Agent code is untrusted
// relative to the control plane: a sandbox sees one checkout and nothing else from the host.
// Docker is a T0/T1 boundary only; it is not adequate for mutually untrusted tenants (T2).

/** Path of the checkout inside every sandbox. */
export const SANDBOX_WORKDIR = "/workspace";
/** Writable, empty home directory inside every sandbox (tmpfs; the root filesystem is read-only). */
export const SANDBOX_HOME = "/home/sandbox";

export type SandboxNetwork =
  /** No network at all. */
  | { readonly kind: "none" }
  /**
   * HTTPS (port 443) to the listed host names only, through an egress proxy that the sandbox
   * reaches via the standard HTTPS_PROXY variables. There is no DNS and no other route out, so a
   * client that ignores the proxy settings cannot connect anywhere.
   */
  | { readonly kind: "allowlist"; readonly hosts: readonly string[] };

export type SandboxMount = {
  /** Absolute host path. */
  readonly source: string;
  /** Absolute path inside the sandbox. */
  readonly target: string;
};

export type SandboxSpec = {
  /** Container image, pinned by digest in production. */
  readonly image: string;
  /** Host directory mounted read-write at SANDBOX_WORKDIR. */
  readonly workdir: string;
  /**
   * Host files or directories mounted read-only, e.g. a tool binary the image lacks. Nothing else
   * from the host is mounted. Targets may not be SANDBOX_WORKDIR, SANDBOX_HOME or below them.
   */
  readonly readOnlyMounts?: readonly SandboxMount[];
  readonly network: SandboxNetwork;
  readonly limits: {
    readonly memoryMb: number;
    readonly cpus: number;
    readonly pids: number;
    /** The sandbox removes itself after this long, even if the control plane is gone. */
    readonly ttlMs: number;
  };
};

export type SandboxHandle = { readonly id: string };

export type SandboxCommand = {
  readonly command: string;
  readonly args: readonly string[];
  /**
   * The environment of the process; nothing is inherited from the host. The sandbox adds only its
   * network settings (the proxy variables of an allowlist network).
   */
  readonly env: Readonly<Record<string, string>>;
  /** Defaults to SANDBOX_WORKDIR. */
  readonly cwd?: string;
};

/** A process running inside a sandbox. Node's ChildProcess satisfies it. */
export interface SandboxProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly killed: boolean;
  readonly exitCode: number | null;
  kill(signal: NodeJS.Signals): boolean;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  off(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  off(event: "error", listener: (error: Error) => void): this;
}

export interface SandboxPort {
  create(spec: SandboxSpec, context: ExecutionContext): Promise<SandboxHandle>;
  /** Starts a process inside the sandbox; it dies with the sandbox. */
  spawn(handle: SandboxHandle, command: SandboxCommand): SandboxProcess;
  /** Idempotent: destroying a sandbox that is already gone succeeds. */
  destroy(handle: SandboxHandle): Promise<void>;
}
