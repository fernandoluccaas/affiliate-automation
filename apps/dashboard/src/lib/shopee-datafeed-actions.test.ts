import { beforeEach, describe, expect, it, vi } from "vitest";

const requireSession = vi.hoisted(() => vi.fn());
const inspect = vi.hoisted(() => vi.fn());
const preview = vi.hoisted(() => vi.fn());
const configuration = vi.hoisted(() => vi.fn());

vi.mock("./session", () => ({ requireSession }));
vi.mock("@affiliate/shopee-affiliate", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@affiliate/shopee-affiliate")>();
  return {
    ...actual,
    inspectShopeeDatafeeds: inspect,
    previewShopeeDatafeeds: preview,
    resolveShopeeAffiliateConfiguration: configuration,
  };
});

import {
  inspectShopeeDatafeedAction,
  previewShopeeDatafeedAction,
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
});
