import { randomBytes } from "node:crypto";
import { buildMercadoLivreAuthorizationUrl, getMercadoLivreConfig } from "@affiliate/marketplace-connectors";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { mercadoLivreOAuthStateCookie } from "@/lib/mercado-livre-oauth";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET() {
  await requireSession();
  const config = getMercadoLivreConfig();

  if (!config.clientId || !config.clientSecret || !config.redirectUri) {
    return NextResponse.redirect(new URL("/integracoes?message=meli-missing-config", config.redirectUri));
  }

  const state = randomBytes(32).toString("base64url");
  const cookieStore = await cookies();
  cookieStore.set(mercadoLivreOAuthStateCookie, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 10 * 60,
  });

  return NextResponse.redirect(buildMercadoLivreAuthorizationUrl(state));
}
