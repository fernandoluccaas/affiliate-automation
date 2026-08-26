import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@affiliate/database";
import { activateControlledShopeeTelegramPublication } from "./shopee-controlled-publication";

const now = new Date("2026-08-25T12:00:00.000Z");

function publication(overrides: Record<string, unknown> = {}) {
  return {
    id: "publication-fixture",
    channelId: "channel-fixture",
    status: "AWAITING_MANUAL_PUBLICATION",
    marketplaceSnapshot: "SHOPEE",
    externalId: null,
    publishedAt: null,
    metadata: {
      publicationMode: "SHOPEE_CONTROLLED",
      distributionState: "PLANNED",
    },
    channel: { type: "TELEGRAM" },
    attempts: [],
    ...overrides,
  };
}

function database(record: unknown, transitionCount = 1) {
  const findFirst = vi.fn().mockResolvedValue(record);
  const updateMany = vi.fn().mockResolvedValue({ count: transitionCount });
  return {
    client: { publication: { findFirst, updateMany } } as unknown as PrismaClient,
    findFirst,
    updateMany,
  };
}

async function activate(
  record: unknown,
  overrides: { channelId?: string; transitionCount?: number } = {},
) {
  const state = database(record, overrides.transitionCount);
  const result = await activateControlledShopeeTelegramPublication({
    publicationId: "publication-fixture",
    channelId: overrides.channelId ?? "channel-fixture",
    now,
    database: state.client,
  });
  return { result, ...state };
}

describe("controlled Shopee Telegram publication activation", () => {
  it("atomically activates an exact planned publication with zero attempts", async () => {
    const { result, updateMany } = await activate(publication());

    expect(result).toEqual({
      ok: true,
      status: "ACTIVATED",
      publicationId: "publication-fixture",
      channelId: "channel-fixture",
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "publication-fixture",
        channelId: "channel-fixture",
        marketplaceSnapshot: "SHOPEE",
        status: "AWAITING_MANUAL_PUBLICATION",
        externalId: null,
        publishedAt: null,
        metadata: {
          equals: {
            publicationMode: "SHOPEE_CONTROLLED",
            distributionState: "PLANNED",
          },
        },
        channel: { is: { type: "TELEGRAM" } },
        attempts: { none: {} },
      }),
      data: expect.objectContaining({
        status: "SCHEDULED",
        scheduledAt: now,
        metadata: expect.objectContaining({
          publicationMode: "SHOPEE_CONTROLLED",
          distributionState: "SCHEDULED",
          autoDistributionActivatedAt: now.toISOString(),
        }),
      }),
    });
  });

  it.each(["ASSISTED", "WEB_EXPERIMENTAL"])(
    "never activates publication mode %s",
    async (publicationMode) => {
      const { result, updateMany } = await activate(
        publication({
          metadata: { publicationMode, distributionState: "PLANNED" },
        }),
      );
      expect(result).toEqual({
        ok: false,
        code: "SHOPEE_CONTROLLED_PUBLICATION_NOT_ACTIVATABLE",
      });
      expect(updateMany).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "SCHEDULED"])(
    "never activates an awaiting publication with distribution state %s",
    async (distributionState) => {
      const { result, updateMany } = await activate(
        publication({
          metadata: {
            publicationMode: "SHOPEE_CONTROLLED",
            ...(distributionState ? { distributionState } : {}),
          },
        }),
      );
      expect(result).toEqual({
        ok: false,
        code: "SHOPEE_CONTROLLED_PUBLICATION_NOT_ACTIVATABLE",
      });
      expect(updateMany).not.toHaveBeenCalled();
    },
  );

  it("requires the exact channel id", async () => {
    const { result, findFirst, updateMany } = await activate(null, {
      channelId: "other-channel",
    });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "publication-fixture",
          channelId: "other-channel",
        },
      }),
    );
    expect(result).toEqual({
      ok: false,
      code: "SHOPEE_CONTROLLED_PUBLICATION_NOT_FOUND",
    });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ["another marketplace", { marketplaceSnapshot: "MERCADO_LIVRE" }],
    ["another channel type", { channel: { type: "WHATSAPP_GROUPS" } }],
    ["an external id", { externalId: "telegram-message" }],
    ["a published timestamp", { publishedAt: now }],
  ])("never activates a publication with %s", async (_label, overrides) => {
    const { result, updateMany } = await activate(publication(overrides));
    expect(result).toEqual({
      ok: false,
      code: "SHOPEE_CONTROLLED_PUBLICATION_NOT_ACTIVATABLE",
    });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it.each([
    "CANCELLED",
    "PUBLISHED",
    "EXPORTED",
    "FAILED",
    "PUBLICATION_FAILED",
  ])(
    "never reactivates status %s",
    async (status) => {
      const { result, updateMany } = await activate(publication({ status }));
      expect(result).toEqual({
        ok: false,
        code: "SHOPEE_CONTROLLED_PUBLICATION_NOT_ACTIVATABLE",
      });
      expect(updateMany).not.toHaveBeenCalled();
    },
  );

  it.each(["PENDING", "SUCCESS", "EXPORTED", "FAILED"])(
    "never activates after a %s attempt",
    async (status) => {
      const { result, updateMany } = await activate(
        publication({ attempts: [{ status }] }),
      );
      expect(result).toEqual({
        ok: false,
        code: "SHOPEE_CONTROLLED_PUBLICATION_ATTEMPT_EXISTS",
      });
      expect(updateMany).not.toHaveBeenCalled();
    },
  );

  it("blocks an uncertain delivery before activation", async () => {
    const { result, updateMany } = await activate(
      publication({
        metadata: {
          publicationMode: "SHOPEE_CONTROLLED",
          distributionState: "PLANNED",
          deliveryUncertain: true,
        },
      }),
    );
    expect(result).toEqual({
      ok: false,
      code: "SHOPEE_DELIVERY_UNCERTAIN_REVIEW_REQUIRED",
    });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("treats an exact controlled scheduled publication idempotently", async () => {
    const { result, updateMany } = await activate(
      publication({
        status: "SCHEDULED",
        metadata: {
          publicationMode: "SHOPEE_CONTROLLED",
          distributionState: "SCHEDULED",
        },
      }),
    );
    expect(result).toEqual({
      ok: true,
      status: "ALREADY_SCHEDULED",
      publicationId: "publication-fixture",
      channelId: "channel-fixture",
    });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("fails closed when the conditional transition loses a race", async () => {
    const { result } = await activate(publication(), { transitionCount: 0 });
    expect(result).toEqual({
      ok: false,
      code: "SHOPEE_CONTROLLED_PUBLICATION_ACTIVATION_CONFLICT",
    });
  });
});
