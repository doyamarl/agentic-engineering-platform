import { z } from "zod";

// Public HTTP contract for /v1/auth and /v1/me (ADR-011). Upper bounds only bound the payload;
// the domain enforces the password and email rules.

export const LoginRequest = z.strictObject({
  email: z.string().max(1000),
  password: z.string().max(1024),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const RefreshRequest = z.strictObject({ refreshToken: z.string().max(200) });
export type RefreshRequest = z.infer<typeof RefreshRequest>;

export const LogoutRequest = RefreshRequest;
export type LogoutRequest = z.infer<typeof LogoutRequest>;

export const ChangePasswordRequest = z.strictObject({
  currentPassword: z.string().max(1024),
  newPassword: z.string().max(1024),
});
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequest>;

export const TokensDto = z.object({
  /** Bearer token for /v1; valid until accessExpiresAt (10 minutes). */
  accessToken: z.string(),
  accessExpiresAt: z.iso.datetime(),
  /**
   * Exchange at /v1/auth/refresh for new tokens; each one works once. A refresh answers without
   * it when a concurrent refresh with the same token already replaced it: keep the newer one.
   */
  refreshToken: z.string().optional(),
  refreshExpiresAt: z.iso.datetime(),
  /** When true, only /v1/me and /v1/auth/password answer until the password is changed. */
  mustChangePassword: z.boolean(),
});
export type TokensDto = z.infer<typeof TokensDto>;

export const MeDto = z.object({
  userId: z.uuid(),
  tenantId: z.uuid(),
  role: z.enum(["admin", "planner", "engineer", "viewer"]),
  mustChangePassword: z.boolean(),
  /** The actions the role allows, e.g. "plan:approve"; for showing only usable controls. */
  permissions: z.array(z.string()),
});
export type MeDto = z.infer<typeof MeDto>;

/** Which login methods the instance offers, for the login page. */
export const AuthMethodsDto = z.object({
  password: z.boolean(),
  /** The identity provider's display name, or null when OIDC login is off. */
  oidc: z.object({ name: z.string() }).nullable(),
});
export type AuthMethodsDto = z.infer<typeof AuthMethodsDto>;

/** Where to send the browser, and the one-time checks the web server keeps for the way back. */
export const OidcStartDto = z.object({
  authorizationUrl: z.url(),
  state: z.string(),
  nonce: z.string(),
  codeVerifier: z.string(),
});
export type OidcStartDto = z.infer<typeof OidcStartDto>;

export const OidcCallbackRequest = z.strictObject({
  /** The query string the provider redirected back with (code and state, or an error). */
  query: z.string().max(8192),
  state: z.string().max(200),
  nonce: z.string().max(200),
  codeVerifier: z.string().max(200),
});
export type OidcCallbackRequest = z.infer<typeof OidcCallbackRequest>;
