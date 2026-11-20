"use server";

// Login, logout and the password change. Next.js checks the Origin of server action requests, so
// other sites cannot post these forms. Error messages never repeat the submitted password.

import { OidcStartDto, TokensDto } from "@aep/contracts";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { callApi, NoContent } from "./lib/api";
import {
  clearedCookies,
  cookieNames,
  oidcCookie,
  safeNext,
  sessionCookies,
  type CookieSpec,
} from "./lib/session";

const text = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
};

async function setCookies(specs: readonly CookieSpec[]): Promise<void> {
  const jar = await cookies();
  for (const { name, value, ...options } of specs) jar.set(name, value, options);
}

export async function login(form: FormData): Promise<never> {
  const next = safeNext(text(form, "next"));
  const result = await callApi(
    "/v1/auth/login",
    {
      method: "POST",
      body: { email: text(form, "email"), password: text(form, "password") },
      auth: false,
    },
    TokensDto,
  );
  if (!result.ok) {
    const error = result.status === 0 ? "unavailable" : "invalid";
    redirect(`/login?error=${error}&next=${encodeURIComponent(next)}`);
  }
  await setCookies(sessionCookies(result.value));
  redirect(result.value.mustChangePassword ? "/password" : next);
}

/** Sends the browser to the identity provider, keeping the one-time checks in a cookie. */
export async function oidcLogin(form: FormData): Promise<never> {
  const next = safeNext(text(form, "next"));
  const result = await callApi(
    "/v1/auth/oidc/start",
    { method: "POST", auth: false },
    OidcStartDto,
  );
  if (!result.ok) redirect(`/login?error=unavailable&next=${encodeURIComponent(next)}`);
  const { authorizationUrl, state, nonce, codeVerifier } = result.value;
  await setCookies([oidcCookie({ state, nonce, codeVerifier, next }, Date.now())]);
  redirect(authorizationUrl);
}

export async function logout(): Promise<never> {
  const jar = await cookies();
  const refreshToken = jar.get(cookieNames().refresh)?.value;
  if (refreshToken !== undefined && refreshToken !== "") {
    // Revoke the session at the API; the cookies go either way.
    await callApi(
      "/v1/auth/logout",
      { method: "POST", body: { refreshToken }, auth: false },
      NoContent,
    );
  }
  await setCookies(clearedCookies());
  redirect("/login");
}

export async function changePassword(form: FormData): Promise<never> {
  const newPassword = text(form, "newPassword");
  if (newPassword !== text(form, "confirmPassword")) {
    redirect(`/password?error=${encodeURIComponent("新しいパスワードが確認用と一致しません")}`);
  }
  const result = await callApi(
    "/v1/auth/password",
    { method: "POST", body: { currentPassword: text(form, "currentPassword"), newPassword } },
    TokensDto,
  );
  if (!result.ok) {
    if (result.status === 401) redirect("/login?next=%2Fpassword");
    redirect(`/password?error=${encodeURIComponent(result.message)}`);
  }
  // Changing the password ended every session, this one included; these are the new ones.
  await setCookies(sessionCookies(result.value));
  redirect("/missions");
}
