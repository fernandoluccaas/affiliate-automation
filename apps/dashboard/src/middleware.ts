import { jwtVerify } from "jose/jwt/verify";
import { NextResponse, type NextRequest } from "next/server";
import { sessionCookieName } from "./lib/session-constants";

export const publicPaths = ["/login", "/api/health"];

export function isPublicPath(pathname: string) {
  return (
    publicPaths.includes(pathname) ||
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

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  const secret = getAuthSecret();
  const token = request.cookies.get(sessionCookieName)?.value;

  if (!secret || !token) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  try {
    await jwtVerify(token, secret);
    return NextResponse.next();
  } catch {
    return NextResponse.redirect(new URL("/login", request.url));
  }
}

export const config = {
  matcher: ["/((?!.*\\..*).*)"],
};
