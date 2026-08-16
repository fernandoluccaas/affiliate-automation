import { beforeEach, describe, expect, it, vi } from "vitest";

const requireSession = vi.hoisted(() => vi.fn());
const inspect = vi.hoisted(() => vi.fn());
const preview = vi.hoisted(() => vi.fn());
const operationalImport = vi.hoisted(() => vi.fn());
const retryLink = vi.hoisted(() => vi.fn());
const manualLink = vi.hoisted(() => vi.fn());
const configuration = vi.hoisted(() => vi.fn());

vi.mock("./session", () => ({ requireSession }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
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
  };
});

import {
  applyManualShopeeAffiliateLinkAction,
  confirmShopeeDatafeedImportAction,
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
    configuration.mockReturnValue({ mode: "DATAFEED" });
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
    await confirmShopeeDatafeedImportAction(input as never);
    expect(operationalImport).toHaveBeenCalledWith(
      expect.objectContaining({
        confirmImport: true,
        subIds: ["source_datafeed", "phase_6a3"],
      }),
    );
    expect(JSON.stringify(operationalImport.mock.calls[0])).not.toMatch(
      /secret|authorization|cookie/i,
    );
  });

  it("runs a controlled retry without exposing credentials", async () => {
    retryLink.mockResolvedValue({ status: "READY_TO_PUBLISH" });
    const result = await retryShopeeAffiliateLinkAction("offer-safe");
    expect(result).toMatchObject({ ok: true });
    expect(retryLink).toHaveBeenCalledWith({
      offerId: "offer-safe",
      subIds: ["source_datafeed", "retry"],
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
  });
});
