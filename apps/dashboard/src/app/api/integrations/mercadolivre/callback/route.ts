import { MercadoLivreOAuthClient, saveMercadoLivreTokenResponse } from "@affiliate/marketplace-connectors";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { mercadoLivreOAuthStateCookie } from "@/lib/mercado-livre-oauth";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

function dashboardUrl(request: NextRequest, message: string) {
  return new URL(`/integracoes?message=${message}`, request.url);
}

export async function GET(request: NextRequest) {
  await requireSession();
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieStore = await cookies();
  const expectedState = cookieStore.get(mercadoLivreOAuthStateCookie)?.value;
  cookieStore.delete(mercadoLivreOAuthStateCookie);

  if (!code || !state || !expectedState || state !== expectedState) {
    return NextResponse.json({ error: "Mercado Livre OAuth state invalido." }, { status: 400 });
  }

  try {
    const token = await new MercadoLivreOAuthClient().exchangeCode(code);
    await saveMercadoLivreTokenResponse(token);
    return NextResponse.redirect(dashboardUrl(request, "meli-connected"));
  } catch {
    return NextResponse.redirect(dashboardUrl(request, "meli-connect-failed"));
  }
}
