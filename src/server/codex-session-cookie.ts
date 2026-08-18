import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

const COOKIE_NAME = "allium_codex_session";
const MAX_AGE_SECONDS = 30 * 60;

type SecretState = typeof globalThis & { __alliumCookieSecret?: Buffer };
const secretState = globalThis as SecretState;

function getSecret() {
  if (process.env.CODEX_SESSION_SECRET) {
    if (process.env.CODEX_SESSION_SECRET.length < 32) {
      throw new Error("CODEX_SESSION_SECRET must contain at least 32 characters.");
    }
    return Buffer.from(process.env.CODEX_SESSION_SECRET);
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("CODEX_SESSION_SECRET is required in production.");
  }

  secretState.__alliumCookieSecret ??= randomBytes(32);
  return secretState.__alliumCookieSecret;
}

function signature(sessionId: string) {
  return createHmac("sha256", getSecret()).update(sessionId).digest("base64url");
}

export async function setCodexSessionCookie(sessionId: string) {
  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, `${sessionId}.${signature(sessionId)}`, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
    priority: "high",
  });
}

export async function readCodexSessionCookie() {
  const value = (await cookies()).get(COOKIE_NAME)?.value;
  if (!value) return null;

  const separator = value.lastIndexOf(".");
  if (separator <= 0) return null;
  const sessionId = value.slice(0, separator);
  const supplied = Buffer.from(value.slice(separator + 1), "base64url");
  const expected = Buffer.from(signature(sessionId), "base64url");

  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return null;
  }
  return sessionId;
}

export async function clearCodexSessionCookie() {
  (await cookies()).delete(COOKIE_NAME);
}

export function requireSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const expectedOrigin = process.env.PUBLIC_ORIGIN
    ? new URL(process.env.PUBLIC_ORIGIN).origin
    : new URL(request.url).origin;

  if (!origin || origin !== expectedOrigin) {
    throw new Error("Cross-origin request rejected.");
  }
}
