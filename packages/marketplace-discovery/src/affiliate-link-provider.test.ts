import { describe, expect, it, vi } from "vitest";
import {
  ManualAffiliateLinkProvider,
  MercadoLivreAffiliateSessionLinkProvider,
  createMercadoLivreAffiliateLinkProvider,
} from "./affiliate-link-provider";

describe("ManualAffiliateLinkProvider", () => {
  it("never fabricates an affiliate link", async () => {
    const provider = new ManualAffiliateLinkProvider();

    await expect(
      provider.generate({
        marketplace: "MERCADO_LIVRE",
        productUrl: "https://produto.mercadolivre.com.br/MLB-123",
        externalProductId: "MLB123",
      }),
    ).resolves.toEqual({
      status: "MANUAL_REQUIRED",
      reason:
        "AFFILIATE_SESSION_NOT_CONFIGURED: configure a sessao do Portal de Afiliados ou importe o link manualmente.",
    });
  });

  it("uses the connected session generator without exposing credentials", async () => {
    const generate = vi.fn().mockResolvedValue({
      status: "GENERATED",
      affiliateUrl: "https://meli.la/real",
      provider: "mercado-livre-affiliate-portal",
    });
    const provider = createMercadoLivreAffiliateLinkProvider({
      sessionStatus: "CONNECTED",
      generate,
    });

    expect(provider).toBeInstanceOf(MercadoLivreAffiliateSessionLinkProvider);
    await expect(
      provider.generate({
        marketplace: "MERCADO_LIVRE",
        productUrl: "https://produto.mercadolivre.com.br/MLB-123",
        externalProductId: "MLB123",
      }),
    ).resolves.toMatchObject({
      status: "GENERATED",
      affiliateUrl: "https://meli.la/real",
    });
  });

  it("falls back explicitly when the persisted session is expired", async () => {
    const provider = createMercadoLivreAffiliateLinkProvider({
      sessionStatus: "EXPIRED",
    });

    await expect(
      provider.generate({
        marketplace: "MERCADO_LIVRE",
        productUrl: "https://produto.mercadolivre.com.br/MLB-123",
      }),
    ).resolves.toEqual({
      status: "MANUAL_REQUIRED",
      reason: "AFFILIATE_SESSION_EXPIRED",
    });
  });
});
