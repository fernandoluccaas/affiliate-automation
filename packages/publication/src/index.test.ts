import { describe, expect, it } from "vitest";
import {
  GENERIC_HEADLINES,
  MERCADO_LIVRE_HEADLINES,
  SHOPEE_HEADLINES,
  buildPromoMessage,
  canScheduleInWindow,
  deterministicMessageComposer,
  formatBRLCurrency,
  formatWhatsAppMessage,
  getZonedDayRange,
  isOfferCompatibleWithChannel,
  isWithinAllowedWindow,
  selectPromotionalHeadline,
  type ChannelPolicy,
} from "./index";

const channel: ChannelPolicy = {
  enabled: true,
  type: "TELEGRAM",
  timezone: "America/Fortaleza",
  dailyPublicationLimit: 2,
  minimumIntervalMinutes: 30,
  allowedStartTime: "08:00",
  allowedEndTime: "22:00",
  minimumScore: 70,
  minimumDiscountPercentage: 10,
  productRepeatIntervalDays: 7,
  allowedMarketplaces: ["SHOPEE"],
  allowedCategories: ["Casa"],
};

describe("deterministicMessageComposer", () => {
  it("formats confirmed offer facts without inventing values", () => {
    const message = deterministicMessageComposer({
      title: "  Oferta   confirmada  ",
      originalPrice: 199.9,
      currentPrice: 149.9,
      discountPercentage: 25.01,
      couponCode: "PROMO",
      couponExpiration: new Date("2026-07-24T12:00:00.000Z"),
      freeShipping: true,
      marketplace: "MERCADO_LIVRE",
      trackingUrl: "https://meli.la/abc123",
    });

    expect(message).toContain("Oferta confirmada");
    expect(message).toContain("De: R$\u00a0199,90");
    expect(message).toContain("Por: R$\u00a0149,90 ✅");
    expect(message).toContain("PROMO");
    expect(message).toContain("🚚 Frete grátis");
    expect(message).toContain("🛒 Compre aqui:");
    expect(message).not.toContain("25,01%");
    expect(message).not.toContain("#publi");
    expect(message.toLowerCase()).not.toContain("link de afiliado");
    expect(message.endsWith("https://meli.la/abc123")).toBe(true);
  });

  it("preserves Portuguese accents and Unicode symbols", () => {
    const message = deterministicMessageComposer({
      title: "Promoção válida para São Luís",
      currentPrice: 345.99,
      marketplace: "SHOPEE",
      trackingUrl: "https://s.shopee.com.br/produto",
    });

    expect(message).toContain("Promoção válida para São Luís");
    expect(message).toContain("R$\u00a0345,99");
    expect(message).toContain("🛒");
    expect(message).not.toContain("Ã");
  });

  it.each([null, undefined, 0, 80])(
    "omits original price when it is %s or not greater than current price",
    (originalPrice) => {
      const message = deterministicMessageComposer({
        title: "Sem preço anterior válido",
        currentPrice: 80,
        ...(originalPrice === undefined ? {} : { originalPrice }),
        marketplace: "MERCADO_LIVRE",
        trackingUrl: "https://meli.la/sem-anterior",
      });

      expect(message).not.toContain("De:");
      expect(message).toContain("Por: R$\u00a080,00 ✅");
    },
  );

  it.each([
    [true, "UNKNOWN", true],
    [false, "UNKNOWN", false],
    [null, "UNKNOWN", false],
    [false, "FREE", true],
  ] as const)(
    "renders free shipping only from confirmed facts",
    (freeShipping, shippingStatus, expected) => {
      const message = deterministicMessageComposer({
        title: "Produto",
        currentPrice: 80,
        freeShipping,
        shippingStatus,
        marketplace: "MERCADO_LIVRE",
        trackingUrl: "https://meli.la/frete",
      });

      expect(message.includes("🚚 Frete grátis")).toBe(expected);
    },
  );

  it("keeps coupon redemption URL and affiliate URL distinct", () => {
    const message = deterministicMessageComposer({
      title: "Produto Shopee",
      originalPrice: 221.78,
      currentPrice: 84.81,
      couponDescription: "10 OFF",
      couponUrl: "https://s.shopee.com.br/CUPOM",
      marketplace: "SHOPEE",
      trackingUrl: "https://s.shopee.com.br/PRODUTO",
    });

    expect(message).toContain(
      "🎟️ Use cupom 10 OFF | resgate aqui:\nhttps://s.shopee.com.br/CUPOM",
    );
    expect(message).toContain(
      "🛒 Compre aqui:\nhttps://s.shopee.com.br/PRODUTO",
    );
  });

  it("omits the entire coupon block when no coupon exists", () => {
    const message = deterministicMessageComposer({
      title: "Sem cupom",
      currentPrice: 80,
      marketplace: "MERCADO_LIVRE",
      trackingUrl: "https://meli.la/sem-cupom",
    });

    expect(message).not.toContain("🎟️");
    expect(message).not.toContain("Use o cupom");
    expect(message).not.toContain("Consulte cupons");
  });

  it("uses the affiliate URL exactly once and preserves an explicit footer", () => {
    const message = deterministicMessageComposer({
      title: "Com rodapé",
      currentPrice: 80,
      marketplace: "MERCADO_LIVRE",
      trackingUrl: "https://meli.la/footer",
      footer: "Rodapé configurado pelo usuário.",
    });

    expect(message.match(/https:\/\/meli\.la\/footer/g)).toHaveLength(1);
    expect(message.endsWith("Rodapé configurado pelo usuário.")).toBe(true);
  });
});

describe("WhatsAppMessageFormatter", () => {
  it("formats immutable facts with WhatsApp marks and one affiliate URL", () => {
    const result = formatWhatsAppMessage({
      title: "Smartphone OPPO A6T 128GB",
      originalPrice: 1299,
      currentPrice: 887.78,
      couponCode: "MELI10",
      freeShipping: true,
      marketplace: "MERCADO_LIVRE",
      trackingUrl: "https://meli.la/abc123",
      customHeader: "Oferta do canal",
      customFooter: "Siga para mais ofertas.",
      seed: "whatsapp-snapshot",
    });

    expect(result.message).toContain("*Smartphone OPPO A6T 128GB*");
    expect(result.message).toContain("De: ~R$\u00a01.299,00~");
    expect(result.message).toContain("Por: *R$\u00a0887,78* ✅");
    expect(result.message).toContain("🚚 Frete grátis");
    expect(result.message).toContain("🎟️ Use o cupom:\nMELI10");
    expect(result.message).toContain("🛒 *Compre aqui:*");
    expect(result.message.match(/https:\/\/meli\.la\/abc123/g)).toHaveLength(1);
    expect(result.message.startsWith("Oferta do canal")).toBe(true);
    expect(result.message.endsWith("Siga para mais ofertas.")).toBe(true);
    expect(result.message).not.toContain("#publi");
    expect(result.message.toLowerCase()).not.toContain("link de afiliado");
  });

  it("omits unconfirmed optional facts and remains deterministic", () => {
    const input = {
      title: "Produto sem adicionais",
      originalPrice: 50,
      currentPrice: 80,
      freeShipping: false,
      marketplace: "MERCADO_LIVRE",
      trackingUrl: "https://meli.la/only",
      seed: "same-publication",
    } as const;
    const first = formatWhatsAppMessage(input).message;
    const second = formatWhatsAppMessage(input).message;

    expect(second).toBe(first);
    expect(first).not.toContain("De:");
    expect(first).not.toContain("Frete grátis");
    expect(first).not.toContain("cupom");
  });
});

describe("promotional headline rotation", () => {
  it("uses only Mercado Livre or generic headlines for Mercado Livre", () => {
    const headline = selectPromotionalHeadline({
      marketplace: "MERCADO_LIVRE",
      seed: "publication-1",
    });
    const allowed = new Set<string>([
      ...MERCADO_LIVRE_HEADLINES,
      ...GENERIC_HEADLINES,
    ]);
    const shopeeOnly = SHOPEE_HEADLINES.filter(
      (item) => !new Set<string>(GENERIC_HEADLINES).has(item),
    );

    expect(allowed.has(headline)).toBe(true);
    expect(shopeeOnly).not.toContain(headline);
  });

  it("uses only Shopee or generic headlines for Shopee", () => {
    const headline = selectPromotionalHeadline({
      marketplace: "SHOPEE",
      seed: "publication-2",
    });
    const allowed = new Set<string>([
      ...SHOPEE_HEADLINES,
      ...GENERIC_HEADLINES,
    ]);
    const mercadoLivreOnly = MERCADO_LIVRE_HEADLINES.filter(
      (item) => !new Set<string>(GENERIC_HEADLINES).has(item),
    );

    expect(allowed.has(headline)).toBe(true);
    expect(mercadoLivreOnly).not.toContain(headline);
  });

  it("does not repeat the immediately previous headline", () => {
    const previous = selectPromotionalHeadline({
      marketplace: "MERCADO_LIVRE",
      seed: "same-seed",
    });
    const next = selectPromotionalHeadline({
      marketplace: "MERCADO_LIVRE",
      seed: "same-seed",
      recentHeadlines: [previous],
    });

    expect(next).not.toBe(previous);
  });

  it("avoids the five most recent headlines when alternatives exist", () => {
    const recent = [...MERCADO_LIVRE_HEADLINES].slice(0, 5);
    const headline = selectPromotionalHeadline({
      marketplace: "MERCADO_LIVRE",
      seed: "channel-offer-publication",
      recentHeadlines: recent,
    });

    expect(recent).not.toContain(headline);
  });

  it("accepts only an allowed, non-recent AI headline suggestion", () => {
    const valid = MERCADO_LIVRE_HEADLINES[0];
    expect(
      buildPromoMessage({
        title: "Produto",
        currentPrice: 100,
        marketplace: "MERCADO_LIVRE",
        trackingUrl: "https://meli.la/safe",
        seed: "safe",
        headlineSuggestion: valid,
      }).headline,
    ).toBe(valid);
    expect(
      buildPromoMessage({
        title: "Produto",
        currentPrice: 100,
        marketplace: "MERCADO_LIVRE",
        trackingUrl: "https://meli.la/safe",
        seed: "safe",
        headlineSuggestion: "SHÔ PIROU DE VEZ 🥵",
      }).headline,
    ).not.toContain("SHÔ");
  });
});

describe("formatBRLCurrency", () => {
  it("uses pt-BR currency formatting", () => {
    expect(formatBRLCurrency(1234.5)).toBe("R$\u00a01.234,50");
  });
});

describe("channel policy", () => {
  const sparseOffer = {
    marketplace: "SHOPEE",
    category: null,
    score: 100,
    scoreCompletenessPercentage: 10,
    discountPercentage: null,
    stockStatus: "UNKNOWN",
    shippingStatus: "UNKNOWN",
  };

  it("accepts compatible offers", () => {
    expect(
      isOfferCompatibleWithChannel(
        {
          marketplace: "SHOPEE",
          category: "Casa",
          score: 90,
          discountPercentage: 20,
        },
        channel,
      ),
    ).toEqual({ ok: true });
  });

  it("accepts sparse offers when channel has no discount, category or score minimum", () => {
    expect(
      isOfferCompatibleWithChannel(sparseOffer, {
        ...channel,
        allowedCategories: [],
        minimumScore: 0,
        minimumDiscountPercentage: 0,
      }),
    ).toEqual({ ok: true });
  });

  it.each([
    [null, null, true],
    [0, null, true],
    [10, null, false],
    [10, 15, true],
    [10, 5, false],
  ])(
    "handles minimum discount %s with offer discount %s",
    (minimumDiscount, discount, expected) => {
      const result = isOfferCompatibleWithChannel(
        { ...sparseOffer, discountPercentage: discount },
        {
          ...channel,
          allowedCategories: [],
          minimumScore: 0,
          minimumDiscountPercentage: minimumDiscount,
        },
      );

      expect(result.ok).toBe(expected);
      if (!expected) {
        expect(result).toMatchObject({ code: "CHANNEL_MIN_DISCOUNT" });
      }
    },
  );

  it.each([
    [[], null, true],
    [["Casa"], null, false],
    [["Casa"], "Casa", true],
    [["Casa"], "Eletronicos", false],
  ])(
    "handles allowed categories %j with offer category %s",
    (allowedCategories, category, expected) => {
      const result = isOfferCompatibleWithChannel(
        { ...sparseOffer, category },
        {
          ...channel,
          allowedCategories,
          minimumScore: 0,
          minimumDiscountPercentage: 0,
        },
      );

      expect(result.ok).toBe(expected);
      if (!expected) {
        expect(result).toMatchObject({ code: "CHANNEL_CATEGORY_MISMATCH" });
      }
    },
  );

  it.each([
    [0, 70, true],
    [80, 100, true],
    [80, 70, false],
  ])(
    "handles minimum score %s with offer score %s",
    (minimumScore, score, expected) => {
      const result = isOfferCompatibleWithChannel(
        { ...sparseOffer, score },
        {
          ...channel,
          allowedCategories: [],
          minimumScore,
          minimumDiscountPercentage: 0,
        },
      );

      expect(result.ok).toBe(expected);
      if (!expected) {
        expect(result).toMatchObject({ code: "CHANNEL_MIN_SCORE" });
      }
    },
  );

  it("does not block unknown stock, unknown shipping or low completeness without explicit policy", () => {
    expect(
      isOfferCompatibleWithChannel(sparseOffer, {
        ...channel,
        allowedCategories: [],
        minimumScore: 0,
        minimumDiscountPercentage: 0,
      }),
    ).toEqual({ ok: true });
  });

  it("rejects incompatible marketplace, low discount and unavailable channels", () => {
    expect(
      isOfferCompatibleWithChannel(
        {
          marketplace: "MERCADO_LIVRE",
          category: "Casa",
          score: 90,
          discountPercentage: 20,
        },
        channel,
      ),
    ).toMatchObject({ ok: false, code: "CHANNEL_MARKETPLACE_MISMATCH" });
    expect(
      isOfferCompatibleWithChannel(
        {
          marketplace: "SHOPEE",
          category: "Casa",
          score: 90,
          discountPercentage: 5,
        },
        channel,
      ),
    ).toMatchObject({ ok: false, code: "CHANNEL_MIN_DISCOUNT" });
    expect(
      isOfferCompatibleWithChannel(
        {
          marketplace: "SHOPEE",
          category: "Casa",
          score: 90,
          discountPercentage: null,
        },
        channel,
      ),
    ).toMatchObject({ ok: false, code: "CHANNEL_MIN_DISCOUNT" });
    expect(
      isOfferCompatibleWithChannel(
        {
          marketplace: "SHOPEE",
          category: "Casa",
          score: 90,
          discountPercentage: 20,
        },
        { ...channel, type: "WHATSAPP_CLOUD_API" },
      ),
    ).toMatchObject({ ok: false, code: "CHANNEL_TYPE_UNAVAILABLE" });
  });

  it("supports assisted WhatsApp groups and rejects the legacy channel type", () => {
    const offer = {
      marketplace: "SHOPEE",
      category: "Casa",
      score: 90,
      discountPercentage: 20,
    };

    expect(
      isOfferCompatibleWithChannel(offer, {
        ...channel,
        type: "WHATSAPP_GROUPS",
      }),
    ).toEqual({ ok: true });
    expect(
      isOfferCompatibleWithChannel(offer, {
        ...channel,
        type: "WHATSAPP_CHANNEL",
      }),
    ).toMatchObject({ ok: false, code: "CHANNEL_TYPE_UNAVAILABLE" });
  });

  it("checks daily limit, interval and product repeat", () => {
    const now = new Date("2026-07-23T15:00:00.000Z");

    expect(
      canScheduleInWindow({ channel, now, publicationsToday: 2 }),
    ).toMatchObject({
      ok: false,
      code: "CHANNEL_DAILY_LIMIT",
    });
    expect(
      canScheduleInWindow({
        channel,
        now,
        publicationsToday: 0,
        lastPublicationAt: new Date("2026-07-23T14:45:00.000Z"),
      }),
    ).toMatchObject({ ok: false, code: "CHANNEL_MIN_INTERVAL" });
    expect(
      canScheduleInWindow({
        channel,
        now,
        publicationsToday: 0,
        lastProductPublicationAt: new Date("2026-07-21T15:00:00.000Z"),
      }),
    ).toMatchObject({ ok: false, code: "CHANNEL_PRODUCT_REPEAT" });
  });

  it("checks timezone-aware allowed hours", () => {
    expect(
      isWithinAllowedWindow(channel, new Date("2026-07-23T15:00:00.000Z")),
    ).toBe(true);
    expect(
      isWithinAllowedWindow(channel, new Date("2026-07-23T04:00:00.000Z")),
    ).toBe(false);
    expect(
      canScheduleInWindow({
        channel,
        now: new Date("2026-07-23T04:00:00.000Z"),
        publicationsToday: 0,
      }),
    ).toMatchObject({ ok: false, code: "CHANNEL_TIME_WINDOW" });
  });

  it("calculates the Brasília day independently from a UTC server day", () => {
    expect(
      getZonedDayRange(
        new Date("2026-07-30T01:30:00.000Z"),
        "America/Sao_Paulo",
      ),
    ).toEqual({
      start: new Date("2026-07-29T03:00:00.000Z"),
      end: new Date("2026-07-30T03:00:00.000Z"),
    });
  });

  it("handles timezone day boundaries across daylight-saving offsets", () => {
    expect(
      getZonedDayRange(
        new Date("2026-03-08T12:00:00.000Z"),
        "America/New_York",
      ),
    ).toEqual({
      start: new Date("2026-03-08T05:00:00.000Z"),
      end: new Date("2026-03-09T04:00:00.000Z"),
    });
  });
});
