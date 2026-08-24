import { describe, expect, it, vi } from "vitest";
import { runShopeePublicationCli } from "./publication-cli";

describe("Shopee publication CLI", () => {
  it("keeps help free of reads and writes", async () => {
    const plan = vi.fn();
    const result = await runShopeePublicationCli(["create", "--help"], {
      plan,
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toMatchObject({
      status: "USAGE",
      externalRequests: 0,
      writes: 0,
      messagesSent: 0,
      stateModified: false,
    });
    expect(plan).not.toHaveBeenCalled();
  });

  it("requires explicit confirmation before creating Publications", async () => {
    const plan = vi.fn();
    const result = await runShopeePublicationCli(["create"], { plan });
    expect(result.exitCode).toBe(2);
    expect(result.output).toMatchObject({
      errorCode: "SHOPEE_PUBLICATION_NOT_CONFIRMED",
      publicationsCreated: 0,
      stateModified: false,
    });
    expect(plan).not.toHaveBeenCalled();
  });

  it("passes a single Offer.id to preview and confirmed creation", async () => {
    const plan = vi.fn().mockResolvedValue({ status: "PREVIEW_COMPLETED" });
    await runShopeePublicationCli(["preview", "--offer-id", "offer-canary"], {
      plan,
    });
    expect(plan).toHaveBeenLastCalledWith(
      expect.objectContaining({ offerId: "offer-canary", preview: true }),
    );

    await runShopeePublicationCli(
      ["create", "--offer-id", "offer-canary", "--confirm-create-publication"],
      { plan },
    );
    expect(plan).toHaveBeenLastCalledWith(
      expect.objectContaining({
        offerId: "offer-canary",
        preview: false,
        confirmCreatePublication: true,
      }),
    );
  });

  it("rejects an absent or repeated Offer.id without reading the store", async () => {
    const plan = vi.fn();
    const absent = await runShopeePublicationCli(["preview", "--offer-id"], {
      plan,
    });
    const repeated = await runShopeePublicationCli(
      ["preview", "--offer-id", "one", "--offer-id", "two"],
      { plan },
    );
    expect(absent.output).toMatchObject({
      errorCode: "SHOPEE_PUBLICATION_OFFER_ID_INVALID",
      stateModified: false,
    });
    expect(repeated.output).toMatchObject({
      errorCode: "SHOPEE_PUBLICATION_OFFER_ID_INVALID",
      stateModified: false,
    });
    expect(plan).not.toHaveBeenCalled();
  });
});
