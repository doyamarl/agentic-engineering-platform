import type { SandboxPort } from "../sandboxes/sandbox-port.ts";
export const reply = (sandbox: SandboxPort): void => {
  sandbox.start();
};
