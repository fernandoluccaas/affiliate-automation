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
    expect(formatBRLCurrency(1234.5)).toBe("R$ 1.234,50");
  });
});

describe("channel policy", () => {
  it("accepts compatible offers", () => {
    expect(
      isOfferCompatibleWithChannel(
        { marketplace: "SHOPEE", category: "Casa", score: 90, discountPercentage: 20 },
        channel,
      ),
    ).toEqual({ ok: true });
  });

  it("rejects incompatible marketplace, low discount and unavailable channels", () => {
    expect(
      isOfferCompatibleWithChannel(
        { marketplace: "MERCADO_LIVRE", category: "Casa", score: 90, discountPercentage: 20 },
        channel,
      ),
    ).toMatchObject({ ok: false });
    expect(
      isOfferCompatibleWithChannel(
        { marketplace: "SHOPEE", category: "Casa", score: 90, discountPercentage: 5 },
        channel,
      ),
    ).toMatchObject({ ok: false });
    expect(
      isOfferCompatibleWithChannel(
        { marketplace: "SHOPEE", category: "Casa", score: 90, discountPercentage: null },
        channel,
      ),
    ).toMatchObject({ ok: false, reason: "Desconto indisponivel para a politica do canal." });
    expect(
      isOfferCompatibleWithChannel(
        { marketplace: "SHOPEE", category: "Casa", score: 90, discountPercentage: 20 },
        { ...channel, type: "WHATSAPP_CLOUD_API" },
      ),
    ).toMatchObject({ ok: false });
  });

  it("checks daily limit, interval and product repeat", () => {
    const now = new Date("2026-07-23T15:00:00.000Z");

    expect(canScheduleInWindow({ channel, now, publicationsToday: 2 })).toMatchObject({
      ok: false,
    });
    expect(
      canScheduleInWindow({
        channel,
        now,
        publicationsToday: 0,
        lastPublicationAt: new Date("2026-07-23T14:45:00.000Z"),
      }),
    ).toMatchObject({ ok: false });
    expect(
      canScheduleInWindow({
        channel,
        now,
        publicationsToday: 0,
        lastProductPublicationAt: new Date("2026-07-21T15:00:00.000Z"),
      }),
    ).toMatchObject({ ok: false });
  });

  it("checks timezone-aware allowed hours", () => {
    expect(isWithinAllowedWindow(channel, new Date("2026-07-23T15:00:00.000Z"))).toBe(true);
    expect(isWithinAllowedWindow(channel, new Date("2026-07-23T04:00:00.000Z"))).toBe(false);
  });
});
