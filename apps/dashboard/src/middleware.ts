import { jwtVerify } from "jose/jwt/verify";
import { NextResponse, type NextRequest } from "next/server";
import { sessionCookieName } from "./lib/session-constants";

export const publicPaths = ["/login", "/api/health"];

export function isPublicPath(pathname: string) {
  return (
    publicPaths.includes(pathname) ||
    pathname.startsWith("/api/health/") ||
    pathname.startsWith("/go/") ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon")
  );
}

function getAuthSecret() {
  const secret = process.env.AUTH_SECRET;

  if (!secret || secret.length < 32) {
    return null;
  }

  return new TextEncoder().encode(secret);
}

function firstForwardedValue(value: string | null) {
  return value
    ?.split(",")[0]
    ?.trim() || null;
}

export function loginRedirectUrl(request: NextRequest) {
  const forwardedHost = firstForwardedValue(
    request.headers.get("x-forwarded-host"),
  );

  const forwardedProto = firstForwardedValue(
    request.headers.get("x-forwarded-proto"),
  );

  if (
    forwardedHost &&
    (forwardedProto === "https" || forwardedProto === "http")
  ) {
    try {
      return new URL(
        "/login",
        `${forwardedProto}://${forwardedHost}`,
      );
    } catch {
      // Fall back to the request URL below.
    }
  }

  return new URL("/login", request.url);
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  const secret = getAuthSecret();
  const token = request.cookies.get(sessionCookieName)?.value;

  if (!secret || !token) {
    return NextResponse.redirect(loginRedirectUrl(request));
  }

  try {
    await jwtVerify(token, secret);
    return NextResponse.next();
  } catch {
    return NextResponse.redirect(loginRedirectUrl(request));
  }
}

export const config = {
  matcher: ["/((?!.*\\..*).*)"],
};