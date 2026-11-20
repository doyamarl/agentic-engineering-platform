// Secrets the platform keeps for people: connector tokens (ADR-013) and, later, model keys
// (ADR-007). They are encrypted at rest under the instance master key. Sealing and opening are
// separate ports so a process can be given the first without the second: whatever only stores a
// secret never needs to read one back.

/**
 * Binds a ciphertext to the row it belongs to, e.g. `connection:<tenant>:<user>:<connector>`.
 * Opening with another context fails, so a ciphertext copied to another person's row is useless.
 */
export type SecretContext = string;

/** Opaque text safe to store in the database. */
export type SealedSecret = string & { readonly __sealed: unique symbol };

export interface SecretSealer {
  seal(plaintext: string, context: SecretContext): SealedSecret;
}

export interface SecretOpener {
  /** Throws SecretOpenError when the ciphertext, the context or the key does not match. */
  open(sealed: SealedSecret, context: SecretContext): string;
}

export class SecretOpenError extends Error {
  constructor(reason: string) {
    super(`secret cannot be opened: ${reason}`);
    this.name = "SecretOpenError";
  }
}
