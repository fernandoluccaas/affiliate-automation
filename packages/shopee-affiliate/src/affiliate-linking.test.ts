import { describe, expect, it, vi } from "vitest";
import {
  generateShopeeAffiliateLinksBulk,
  type ShopeeAffiliateLinkApplicationResult,
} from "./operational";
import { ShopeeOpenApiError } from "./open-api";
import type { ShopeeAffiliateLinkProvider } from "./types";

const environment = {
  SHOPEE_AFFILIATE_ENABLED: "true",
  SHOPEE_AFFILIATE_MODE: "HYBRID",
  SHOPEE_OPEN_API_APP_ID: "fixture-app",
  SHOPEE_OPEN_API_SECRET: "fixture-secret",
};

function offer(index: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `offer-${String(index).padStart(2, "0")}`,
    marketplace: "SHOPEE",
    externalProductId: String(1000 + index),
    productUrl: `https://shopee.com.br/product/10/${1000 + index}`,
    affiliateUrl: null,
    status: "READY_FOR_AFFILIATE_LINK",
    version: 1,
    ...overrides,
  };
}

function linked(offerId: string): ShopeeAffiliateLinkApplicationResult {
  return {
    status: "LINKED",
    offerId,
    itemId: offerId.replace("offer-", "10"),
    attempts: 1,
    linkStatus: "GENERATED",
    offerStatus: "READY_TO_PUBLISH",
  };
}

function run(input: {
  offers: ReturnType<typeof offer>[];
  applyLink?: (...args: never[]) => unknown;
  offerIds?: string[];
  maxItems?: number;
  dryRun?: boolean;
  sleep?: (milliseconds: number) => Promise<void>;
  linkProvider?: ShopeeAffiliateLinkProvider;
}) {
  const applyLink =
    input.applyLink ?? vi.fn(async ({ offerId }) => linked(offerId));
  return {
    applyLink,
    result: generateShopeeAffiliateLinksBulk({
      source: "MANUAL_BULK",
      confirmGenerate: !input.dryRun,
      ...(input.dryRun !== undefined ? { dryRun: input.dryRun } : {}),
      environment,
      ...(input.offerIds ? { offerIds: input.offerIds } : {}),
      ...(input.maxItems ? { maxItems: input.maxItems } : {}),
      ...(input.linkProvider ? { linkProvider: input.linkProvider } : {}),
      dependencies: {
        loadOffers: async () => input.offers,
        applyLink: applyLink as never,
        sleep: input.sleep ?? (async () => undefined),
        now: () => 1_000,
      },
    }),
  };
}

describe("Shopee bulk affiliate linking", () => {
  it("links one eligible pending offer", async () => {
    const { result, applyLink } = run({ offers: [offer(1)] });
    await expect(result).resolves.toMatchObject({
      status: "SUCCEEDED",
      requested: 1,
      eligible: 1,
      attempted: 1,
      linked: 1,
      readyToPublish: 1,
      remainingPending: 0,
      publicationsCreated: 0,
      messagesSent: 0,
    });
    expect(applyLink).toHaveBeenCalledOnce();
  });

  it("processes at most twelve offers sequentially in deterministic order", async () => {
    const offers = Array.from({ length: 13 }, (_, index) => offer(index + 1));
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;
    const applyLink = vi.fn(async ({ offerId }: { offerId: string }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push(offerId);
      await Promise.resolve();
      active -= 1;
      return linked(offerId);
    });
    const { result } = run({ offers: [...offers].reverse(), applyLink });
    await expect(result).resolves.toMatchObject({
      linked: 12,
      apiAttempts: 12,
    });
    expect(maxActive).toBe(1);
    expect(order).toEqual(offers.slice(0, 12).map((item) => item.id));
  });

  it("keeps ten successes when two offer-specific failures occur", async () => {
    const offers = Array.from({ length: 12 }, (_, index) => offer(index + 1));
    const applyLink = vi.fn(async ({ offerId }: { offerId: string }) => {
      if (["offer-03", "offer-08"].includes(offerId)) {
        throw new ShopeeOpenApiError("SHOPEE_ORIGIN_URL_INVALID");
      }
      return linked(offerId);
    });
    const result = await run({ offers, applyLink }).result;
    expect(result).toMatchObject({
      status: "SUCCEEDED_WITH_ERRORS",
      linked: 10,
      failed: 2,
      remainingPending: 2,
      publicationsCreated: 0,
      messagesSent: 0,
    });
    expect(applyLink).toHaveBeenCalledTimes(12);
  });

  it("aborts remaining offers after a global authentication failure", async () => {
    const offers = [offer(1), offer(2), offer(3)];
    const applyLink = vi.fn(async () => {
      throw new ShopeeOpenApiError("SHOPEE_OPEN_API_AUTHENTICATION_FAILED");
    });
    const result = await run({ offers, applyLink }).result;
    expect(result).toMatchObject({
      status: "FAILED",
      failed: 1,
      notAttempted: 2,
    });
    expect(result.items.map((item) => item.status)).toEqual([
      "FAILED",
      "NOT_ATTEMPTED",
      "NOT_ATTEMPTED",
    ]);
    expect(applyLink).toHaveBeenCalledOnce();
  });

  it("skips an existing link, a ready offer and a simulated race", async () => {
    const applyLink = vi.fn(async ({ offerId }: { offerId: string }) => ({
      ...linked(offerId),
      status: "ALREADY_LINKED" as const,
      linkStatus: "EXISTING" as const,
    }));
    const result = await run({
      offers: [
        offer(1, {
          status: "READY_TO_PUBLISH",
          affiliateUrl: "https://s.shopee.com.br/existing",
        }),
        offer(2),
      ],
      applyLink,
    }).result;
    expect(result).toMatchObject({
      linked: 0,
      alreadyLinked: 2,
      apiAttempts: 0,
      writes: 0,
    });
    expect(applyLink).toHaveBeenCalledOnce();
  });

  it("rejects another marketplace and an ineligible offer without API calls", async () => {
    const { result, applyLink } = run({
      offers: [
        offer(1, { marketplace: "MERCADO_LIVRE" }),
        offer(2, { status: "REJECTED_INVALID_DATA" }),
      ],
    });
    await expect(result).resolves.toMatchObject({ failed: 2, apiAttempts: 0 });
    expect(applyLink).not.toHaveBeenCalled();
  });

  it("enforces confirmation, maximum size, empty input and read-only dry-run", async () => {
    await expect(
      generateShopeeAffiliateLinksBulk({
        source: "MANUAL_BULK",
        confirmGenerate: false,
        environment,
      }),
    ).rejects.toThrow("SHOPEE_BULK_LINK_NOT_CONFIRMED");
    await expect(
      generateShopeeAffiliateLinksBulk({
        offerIds: Array.from({ length: 13 }, (_, index) => `offer-${index}`),
        maxItems: 12,
        source: "MANUAL_BULK",
        confirmGenerate: true,
        environment,
      }),
    ).rejects.toThrow("SHOPEE_BULK_LINK_MAX_EXCEEDED");
    await expect(run({ offers: [] }).result).resolves.toMatchObject({
      status: "SUCCEEDED",
      requested: 0,
      externalRequests: 0,
      writes: 0,
    });
    const dryRun = run({ offers: [offer(1)], dryRun: true });
    await expect(dryRun.result).resolves.toMatchObject({
      status: "DRY_RUN",
      eligible: 1,
      externalRequests: 0,
      writes: 0,
    });
    expect(dryRun.applyLink).not.toHaveBeenCalled();
  });

  it.each([
    "SHOPEE_OPEN_API_TIMEOUT",
    "SHOPEE_OPEN_API_REQUEST_FAILED",
    "SHOPEE_OPEN_API_HTTP_ERROR",
    "SHOPEE_OPEN_API_RATE_LIMITED",
  ])("retries one time for recoverable %s", async (errorCode) => {
    const applyLink = vi
      .fn()
      .mockRejectedValueOnce(new ShopeeOpenApiError(errorCode, true))
      .mockResolvedValueOnce(linked("offer-01"));
    const result = await run({ offers: [offer(1)], applyLink }).result;
    expect(result).toMatchObject({
      linked: 1,
      retryAttempts: 1,
      apiAttempts: 2,
    });
    expect(applyLink).toHaveBeenCalledTimes(2);
  });

  it.each([
    "SHOPEE_SUB_ID_INVALID",
    "SHOPEE_OPEN_API_AUTHENTICATION_FAILED",
    "SHOPEE_OPEN_API_NOT_READY",
  ])("does not retry deterministic %s", async (errorCode) => {
    const applyLink = vi.fn(async () => {
      throw new ShopeeOpenApiError(errorCode);
    });
    const result = await run({ offers: [offer(1)], applyLink }).result;
    expect(result).toMatchObject({ linked: 0, failed: 1, retryAttempts: 0 });
    expect(applyLink).toHaveBeenCalledOnce();
  });

  it("reuses one provider instance so every request shares the client limiter", async () => {
    const provider = {
      kind: "OPEN_API" as const,
      resolve: vi.fn(),
    } as ShopeeAffiliateLinkProvider;
    const applyLink = vi.fn(async ({ offerId }) => linked(offerId));
    await run({
      offers: [offer(1), offer(2)],
      applyLink,
      linkProvider: provider,
    }).result;
    expect(applyLink).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ linkProvider: provider }),
    );
    expect(applyLink).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ linkProvider: provider }),
    );
  });

  it("is idempotent across repeated executions after the first link is applied", async () => {
    let current = offer(1);
    const applyLink = vi.fn(async ({ offerId }: { offerId: string }) => {
      current = offer(1, {
        status: "READY_TO_PUBLISH",
        affiliateUrl: "https://s.shopee.com.br/alreadylinked",
      });
      return linked(offerId);
    });
    const execute = () =>
      generateShopeeAffiliateLinksBulk({
        offerIds: ["offer-01"],
        source: "MANUAL_BULK",
        confirmGenerate: true,
        environment,
        dependencies: {
          loadOffers: async () => [current],
          applyLink: applyLink as never,
          sleep: async () => undefined,
        },
      });
    await expect(execute()).resolves.toMatchObject({ linked: 1 });
    await expect(execute()).resolves.toMatchObject({
      linked: 0,
      alreadyLinked: 1,
      apiAttempts: 0,
      writes: 0,
    });
    expect(applyLink).toHaveBeenCalledOnce();
  });
});
