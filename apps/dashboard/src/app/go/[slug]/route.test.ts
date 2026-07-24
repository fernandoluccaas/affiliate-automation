import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  affiliateLink: {
    findUnique: vi.fn(),
  },
  publication: {
    findFirst: vi.fn(),
  },
  click: {
    create: vi.fn(),
  },
}));

const lockMock = vi.hoisted(() => ({
  release: vi.fn(),
}));

vi.mock("@affiliate/database", () => ({ prisma: prismaMock }));
vi.mock("@affiliate/redis", () => ({
  acquireLock: vi.fn(async () => ({ acquired: true, release: lockMock.release })),
}));

import { GET } from "./route";

const affiliateLink = {
  id: "link-1",
  offerId: "offer-1",
  destination: "https://example.com/affiliate",
  marketplace: "SHOPEE",
  active: true,
  offer: {
    affiliateUrl: "https://example.com/affiliate",
    productUrl: "https://example.com/product",
    product: null,
  },
};

describe("/go/[slug]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.affiliateLink.findUnique.mockResolvedValue(affiliateLink);
    prismaMock.publication.findFirst.mockResolvedValue({ id: "publication-1", channelId: "channel-1" });
    prismaMock.click.create.mockResolvedValue({ id: "click-1" });
  });

  it("records a click and redirects temporarily", async () => {
    const response = await GET(
      new NextRequest("http://localhost/go/oferta-1", {
        headers: { referer: "https://referer.test", "user-agent": "vitest" },
      }),
      { params: Promise.resolve({ slug: "oferta-1" }) },
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://example.com/affiliate");
    expect(prismaMock.click.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        affiliateLinkId: "link-1",
        offerId: "offer-1",
        publicationId: "publication-1",
        channelId: "channel-1",
        marketplace: "SHOPEE",
        referer: "https://referer.test",
        userAgent: "vitest",
      }),
    });
  });

  it("returns 404 for inactive or missing slug", async () => {
    prismaMock.affiliateLink.findUnique.mockResolvedValue(null);

    const response = await GET(new NextRequest("http://localhost/go/missing"), {
      params: Promise.resolve({ slug: "missing" }),
    });

    expect(response.status).toBe(404);
  });

  it("redirects even when tracking fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    prismaMock.click.create.mockRejectedValue(new Error("database unavailable"));

    const response = await GET(new NextRequest("http://localhost/go/oferta-1"), {
      params: Promise.resolve({ slug: "oferta-1" }),
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://example.com/affiliate");
    consoleError.mockRestore();
  });
});
