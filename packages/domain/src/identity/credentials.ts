import { err, ok, type Result } from "../result.ts";

// Rules for the credentials people log in with (ADR-011).

export const MIN_PASSWORD_LENGTH = 12;
/** Bounds the work an attacker can force on the hasher with one request. */
export const MAX_PASSWORD_LENGTH = 256;
/** RFC 5321 limits a forward path to 256 octets including the angle brackets. */
export const MAX_EMAIL_LENGTH = 254;

export type InvalidCredential = {
  readonly kind: "InvalidCredential";
  readonly field: "email" | "password" | "displayName";
  readonly reason: string;
};

/** Length in code points, so a password of emoji is not judged by its UTF-16 units. */
const codePoints = (text: string): number => Array.from(text).length;

export function validatePassword(password: string): Result<string, InvalidCredential> {
  const length = codePoints(password);
  if (length < MIN_PASSWORD_LENGTH || length > MAX_PASSWORD_LENGTH) {
    return err({
      kind: "InvalidCredential",
      field: "password",
      reason: `must be ${String(MIN_PASSWORD_LENGTH)} to ${String(MAX_PASSWORD_LENGTH)} characters`,
    });
  }
  return ok(password);
}

// One "@" with something on both sides and no whitespace. Deliverability is the identity
// provider's or the admin's concern; this only keeps obvious mistakes out of the unique index.
const EMAIL = /^[^\s@]+@[^\s@]+$/;

/** Trims and lower-cases, so one address cannot be registered twice under different cases. */
export function normalizeEmail(email: string): Result<string, InvalidCredential> {
  const normalized = email.trim().toLowerCase();
  if (normalized.length > MAX_EMAIL_LENGTH || !EMAIL.test(normalized)) {
    return err({ kind: "InvalidCredential", field: "email", reason: "is not an email address" });
  }
  return ok(normalized);
}

export const MAX_DISPLAY_NAME_LENGTH = 200;

/** Trims; 1 to 200 characters, as the users table requires. */
export function validateDisplayName(name: string): Result<string, InvalidCredential> {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_DISPLAY_NAME_LENGTH) {
    return err({
      kind: "InvalidCredential",
      field: "displayName",
      reason: `must be 1 to ${String(MAX_DISPLAY_NAME_LENGTH)} characters`,
    });
  }
  return ok(trimmed);
}
