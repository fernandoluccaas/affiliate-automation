import { beforeEach, describe, expect, it, vi } from "vitest";

const requireSession = vi.hoisted(() => vi.fn());
const inspect = vi.hoisted(() => vi.fn());
const preview = vi.hoisted(() => vi.fn());
const operationalImport = vi.hoisted(() => vi.fn());
const retryLink = vi.hoisted(() => vi.fn());
const manualLink = vi.hoisted(() => vi.fn());
const configuration = vi.hoisted(() => vi.fn());
const recentItems = vi.hoisted(() => vi.fn());
const offerState = vi.hoisted(() => vi.fn());
const bulkLinks = vi.hoisted(() => vi.fn());

vi.mock("./session", () => ({ requireSession }));
vi.mock("@affiliate/shopee-affiliate", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@affiliate/shopee-affiliate")>();
  return {
    ...actual,
    inspectShopeeDatafeeds: inspect,
    previewShopeeDatafeeds: preview,
    importShopeeOperationalOffers: operationalImport,
    retryShopeeAffiliateLink: retryLink,
    applyManualShopeeAffiliateLink: manualLink,
    resolveShopeeAffiliateConfiguration: configuration,
    loadRecentShopeeItemIds: recentItems,
    loadShopeeOperationalOfferState: offerState,
    generateShopeeAffiliateLinksBulk: bulkLinks,
  };
});

import {
  applyManualShopeeAffiliateLinkAction,
  confirmShopeeDatafeedImportAction,
  generatePendingShopeeAffiliateLinksAction,
  inspectShopeeDatafeedAction,
  previewShopeeDatafeedAction,
  retryShopeeAffiliateLinkAction,
} from "./shopee-datafeed-actions";

const input = {
  files: ["C:\\feeds\\shopee.csv"],
  categories: [
    "CELULARES",
    "CASA",
    "MODA",
    "RELOGIOS",
    "AUTOMOTIVO",
    "ELETRODOMESTICOS",
  ].map((id, index) => ({
    id,
    enabled: true,
    priority: 60 - index * 10,
    minPerCategory: 1,
    maxPerCategory: 2,
  })),
  filters: {
    priceMin: null,
    priceMax: null,
    discountMin: 20,
    itemRatingMin: 4.7,
    shopRatingMin: null,
    crossBorderAllowed: false,
    forbiddenWords: [],
  },
};

describe("Shopee dashboard Server Actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireSession.mockResolvedValue({ id: "user", role: "ADMIN" });
    configuration.mockReturnValue({
      mode: "DATAFEED",
      recentSelectionWindowDays: 7,
      maxPerShopPerSession: 2,
    });
    recentItems.mockResolvedValue([]);
    offerState.mockResolvedValue({
      offerCounts: { pending: 0, ready: 1 },
      pendingOffers: [],
    });
  });

  it("requires an authenticated authorized session", async () => {
    requireSession.mockResolvedValue({ id: "viewer", role: "VIEWER" });
    const result = await inspectShopeeDatafeedAction(input as never);
    expect(result).toMatchObject({
      ok: false,
      errorCode: "SHOPEE_NOT_AUTHORIZED",
    });
    expect(inspect).not.toHaveBeenCalled();
  });

  it("fails closed outside DATAFEED mode", async () => {
    configuration.mockReturnValue({ mode: "OFF" });
    const result = await inspectShopeeDatafeedAction(input as never);
    expect(result).toMatchObject({
      ok: false,
      errorCode: "SHOPEE_DATAFEED_MODE_REQUIRED",
    });
  });

  it("validates input before opening a file", async () => {
    const result = await inspectShopeeDatafeedAction({
      ...input,
      files: [],
    } as never);
    expect(result).toMatchObject({
      ok: false,
      errorCode: "SHOPEE_DATAFEED_INPUT_INVALID",
    });
    expect(inspect).not.toHaveBeenCalled();
  });

  it("returns a sanitized successful preview DTO", async () => {
    preview.mockResolvedValue({
      selected: [],
      databaseWrites: 0,
      publicationsCreated: 0,
      messagesSent: 0,
    });
    const result = await previewShopeeDatafeedAction(input as never);
    expect(result).toMatchObject({
      ok: true,
      data: { databaseWrites: 0, publicationsCreated: 0, messagesSent: 0 },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /cookie|token|secret|authorization/i,
    );
    expect(recentItems).toHaveBeenCalledWith({ windowDays: 7 });
    expect(preview).toHaveBeenCalledWith(
      expect.objectContaining({ recentItemIds: [], maxPerShop: 2 }),
    );
  });

  it("requires a dedicated confirmation action before operational writes", async () => {
    operationalImport.mockResolvedValue({
      metrics: {
        readyToPublish: 2,
        pendingAffiliateLink: 1,
        failed: 0,
      },
      publicationsCreated: 0,
      messagesSent: 0,
    });
    const result = await confirmShopeeDatafeedImportAction(input as never);
    expect(operationalImport).toHaveBeenCalledWith(
      expect.objectContaining({
        confirmImport: true,
        subIds: ["sourcedatafeed", "autolink"],
      }),
    );
    expect(JSON.stringify(operationalImport.mock.calls[0])).not.toMatch(
      /secret|authorization|cookie/i,
    );
    expect(result).toMatchObject({
      ok: true,
      offerState: { offerCounts: { pending: 0, ready: 1 } },
    });
  });

  it("runs a controlled retry without exposing credentials", async () => {
    retryLink.mockResolvedValue({ status: "READY_TO_PUBLISH" });
    const result = await retryShopeeAffiliateLinkAction("offer-safe");
    expect(result).toMatchObject({ ok: true });
    expect(retryLink).toHaveBeenCalledWith({
      offerId: "offer-safe",
      subIds: ["sourcedatafeed", "retry"],
    });
    expect(JSON.stringify(retryLink.mock.calls)).not.toContain(
      "source_datafeed",
    );
    expect(offerState).toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/secret|authorization|cookie/i);
  });

  it("requires backend confirmation before bulk linking", async () => {
    const result = await generatePendingShopeeAffiliateLinksAction({
      confirmGenerate: false,
      maxItems: 12,
    });
    expect(result).toMatchObject({
      ok: false,
      errorCode: "SHOPEE_BULK_LINK_NOT_CONFIRMED",
    });
    expect(bulkLinks).not.toHaveBeenCalled();
  });

  it("generates pending links with valid SubIds and a sanitized partial DTO", async () => {
    bulkLinks.mockResolvedValue({
      status: "SUCCEEDED_WITH_ERRORS",
      linked: 10,
      remainingPending: 2,
      publicationsCreated: 0,
      messagesSent: 0,
      items: [
        {
          offerId: "offer-safe",
          itemId: "123",
          status: "FAILED",
          attempts: 1,
          errorCode: "SHOPEE_ORIGIN_URL_INVALID",
        },
      ],
    });
    const result = await generatePendingShopeeAffiliateLinksAction({
      confirmGenerate: true,
      maxItems: 12,
    });
    expect(result).toMatchObject({
      ok: true,
      message: "10 links aplicados; 2 ofertas ainda precisam de atenção.",
    });
    expect(bulkLinks).toHaveBeenCalledWith({
      source: "MANUAL_BULK",
      confirmGenerate: true,
      maxItems: 12,
      subIds: ["sourcedatafeed", "bulk"],
    });
    expect(JSON.stringify(result)).not.toMatch(
      /secret|authorization|signature|graphql/i,
    );
    expect(offerState).toHaveBeenCalled();
  });

  it("returns a specific sanitized message for an Open API GraphQL error", async () => {
    retryLink.mockRejectedValue(new Error("SHOPEE_OPEN_API_GRAPHQL_ERROR"));
    const result = await retryShopeeAffiliateLinkAction("offer-safe");
    expect(result).toEqual({
      ok: false,
      errorCode: "SHOPEE_OPEN_API_GRAPHQL_ERROR",
      message: "Não foi possível gerar o link pela Open API da Shopee.",
    });
    expect(JSON.stringify(result)).not.toMatch(/secret|authorization|cookie/i);
  });

  it("returns a specific sanitized message for an invalid SubId", async () => {
    retryLink.mockRejectedValue(new Error("SHOPEE_SUB_ID_INVALID"));
    const result = await retryShopeeAffiliateLinkAction("offer-safe");
    expect(result).toEqual({
      ok: false,
      errorCode: "SHOPEE_SUB_ID_INVALID",
      message: "Os identificadores de rastreamento do link são inválidos.",
    });
    expect(JSON.stringify(result)).not.toMatch(/secret|authorization|cookie/i);
  });

  it("validates and delegates the separate manual fallback", async () => {
    manualLink.mockResolvedValue({ status: "READY_TO_PUBLISH" });
    const result = await applyManualShopeeAffiliateLinkAction({
      offerId: "offer-safe",
      affiliateUrl: "https://s.shopee.com.br/fixture",
    });
    expect(result).toMatchObject({ ok: true });
    expect(manualLink).toHaveBeenCalledWith({
      offerId: "offer-safe",
      affiliateUrl: "https://s.shopee.com.br/fixture",
    });
    expect(result).toMatchObject({
      offerState: { offerCounts: { pending: 0, ready: 1 } },
    });
  });
});
