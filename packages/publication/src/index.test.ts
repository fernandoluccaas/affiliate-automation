import { describe, expect, it } from "vitest";
import {
  canScheduleInWindow,
  deterministicMessageComposer,
  formatBRLCurrency,
  isOfferCompatibleWithChannel,
  isWithinAllowedWindow,
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
      title: "Oferta confirmada",
      originalPrice: 199.9,
      currentPrice: 149.9,
      discountPercentage: 25.01,
      couponCode: "PROMO",
      couponExpiration: new Date("2026-07-24T12:00:00.000Z"),
      freeShipping: true,
      marketplace: "SHOPEE",
      trackingUrl: "https://example.com/go/slug",
    });

    expect(message).toContain("Oferta confirmada");
    expect(message).toContain("R$");
    expect(message).toContain("PROMO");
    expect(message).toContain("Frete gratis");
    expect(message).toContain("#publi");
    expect(message).toContain("\u{1F525}");
    expect(message).toContain("\u{1F6D2}");
    expect(message).not.toContain("Ã°Å¸");
    expect(message).not.toContain("Ãƒ");
    expect(message).not.toContain("Ã‚");
  });

  it("preserves Portuguese accents and Unicode symbols", () => {
    const message = deterministicMessageComposer({
      title: "Promoção válida para São Luís",
      currentPrice: 345.99,
      marketplace: "SHOPEE",
      trackingUrl: "https://example.com/go/slug",
    });

    expect(message).toContain("Promoção válida para São Luís");
    expect(message).toContain("\u{1F525}");
    expect(message).toContain("\u{1F6D2}");
    expect(message).not.toContain("Ã°Å¸");
    expect(message).not.toContain("Ãƒ");
    expect(message).not.toContain("Ã‚");
  });

  it("omits optional lines when facts are absent", () => {
    const message = deterministicMessageComposer({
      title: "Sem opcionais",
      currentPrice: 80,
      originalPrice: null,
      discountPercentage: null,
      freeShipping: null,
      shippingStatus: "UNKNOWN",
      marketplace: "SHOPEE",
      trackingUrl: "https://example.com/go/slug",
    });

    expect(message).not.toContain("De ");
    expect(message).not.toContain("% de desconto");
    expect(message).not.toContain("Cupom");
    expect(message).not.toContain("Frete gratis");
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
        { marketplace: "SHOPEE", category: "Casa", score: 90, discountPercentage: 20 },
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
  ])("handles minimum discount %s with offer discount %s", (minimumDiscount, discount, expected) => {
    const result = isOfferCompatibleWithChannel(
      { ...sparseOffer, discountPercentage: discount },
      { ...channel, allowedCategories: [], minimumScore: 0, minimumDiscountPercentage: minimumDiscount },
    );

    expect(result.ok).toBe(expected);
    if (!expected) {
      expect(result).toMatchObject({ code: "CHANNEL_MIN_DISCOUNT" });
    }
  });

  it.each([
    [[], null, true],
    [["Casa"], null, false],
    [["Casa"], "Casa", true],
    [["Casa"], "Eletronicos", false],
  ])("handles allowed categories %j with offer category %s", (allowedCategories, category, expected) => {
    const result = isOfferCompatibleWithChannel(
      { ...sparseOffer, category },
      { ...channel, allowedCategories, minimumScore: 0, minimumDiscountPercentage: 0 },
    );

    expect(result.ok).toBe(expected);
    if (!expected) {
      expect(result).toMatchObject({ code: "CHANNEL_CATEGORY_MISMATCH" });
    }
  });

  it.each([
    [0, 70, true],
    [80, 100, true],
    [80, 70, false],
  ])("handles minimum score %s with offer score %s", (minimumScore, score, expected) => {
    const result = isOfferCompatibleWithChannel(
      { ...sparseOffer, score },
      { ...channel, allowedCategories: [], minimumScore, minimumDiscountPercentage: 0 },
    );

    expect(result.ok).toBe(expected);
    if (!expected) {
      expect(result).toMatchObject({ code: "CHANNEL_MIN_SCORE" });
    }
  });

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
        { marketplace: "MERCADO_LIVRE", category: "Casa", score: 90, discountPercentage: 20 },
        channel,
      ),
    ).toMatchObject({ ok: false, code: "CHANNEL_MARKETPLACE_MISMATCH" });
    expect(
      isOfferCompatibleWithChannel(
        { marketplace: "SHOPEE", category: "Casa", score: 90, discountPercentage: 5 },
        channel,
      ),
    ).toMatchObject({ ok: false, code: "CHANNEL_MIN_DISCOUNT" });
    expect(
      isOfferCompatibleWithChannel(
        { marketplace: "SHOPEE", category: "Casa", score: 90, discountPercentage: null },
        channel,
      ),
    ).toMatchObject({ ok: false, code: "CHANNEL_MIN_DISCOUNT" });
    expect(
      isOfferCompatibleWithChannel(
        { marketplace: "SHOPEE", category: "Casa", score: 90, discountPercentage: 20 },
        { ...channel, type: "WHATSAPP_CLOUD_API" },
      ),
    ).toMatchObject({ ok: false, code: "CHANNEL_TYPE_UNAVAILABLE" });
  });

  it("checks daily limit, interval and product repeat", () => {
    const now = new Date("2026-07-23T15:00:00.000Z");

    expect(canScheduleInWindow({ channel, now, publicationsToday: 2 })).toMatchObject({
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
    expect(isWithinAllowedWindow(channel, new Date("2026-07-23T15:00:00.000Z"))).toBe(true);
    expect(isWithinAllowedWindow(channel, new Date("2026-07-23T04:00:00.000Z"))).toBe(false);
    expect(canScheduleInWindow({ channel, now: new Date("2026-07-23T04:00:00.000Z"), publicationsToday: 0 }))
      .toMatchObject({ ok: false, code: "CHANNEL_TIME_WINDOW" });
  });
});
