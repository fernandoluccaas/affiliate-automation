import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  affiliateLink: { findUnique: vi.fn() },
  publication: { findMany: vi.fn() },
  click: { create: vi.fn() },
  trackingDailyMetric: { upsert: vi.fn() },
}));
const consumeFixedWindow = vi.hoisted(() => vi.fn());

vi.mock("@affiliate/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@affiliate/database")>()),
  prisma: prismaMock,
}));
vi.mock("@affiliate/redis", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@affiliate/redis")>()),
  consumeFixedWindow,
}));

import { GET } from "./route";

const affiliateLink = {
  id: "link-1",
  offerId: "offer-1",
  destination: "https://s.shopee.com.br/fixture",
  marketplace: "SHOPEE",
  active: true,
};

function request(input: { ip?: string; referer?: string; userAgent?: string } = {}) {
  return new NextRequest("http://localhost/go/oferta-1", {
    headers: {
      "x-forwarded-for": input.ip ?? "203.0.113.10",
      referer: input.referer ?? "https://origin.example/path?token=private#fragment",
      "user-agent": input.userAgent ?? "Mozilla/5.0 Mobile fixture",
    },
  });
}

async function call(input: { ip?: string; referer?: string; userAgent?: string } = {}) {
  return GET(request(input), { params: Promise.resolve({ slug: "oferta-1" }) });
}

describe("/go/[slug] hardened redirect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("TRACKING_ENABLED", "true");
    vi.stubEnv("TRACKING_RATE_LIMIT_ENABLED", "true");
    vi.stubEnv("TRACKING_FINGERPRINT_SECRET", "test-only-fingerprint-secret-32-characters");
    vi.stubEnv("TRACKING_TRUST_PROXY_HEADERS", "true");
    prismaMock.affiliateLink.findUnique.mockResolvedValue(affiliateLink);
    prismaMock.publication.findMany.mockResolvedValue([{ id: "publication-1", channelId: "channel-1" }]);
    prismaMock.click.create.mockResolvedValue({ id: "click-1" });
    prismaMock.trackingDailyMetric.upsert.mockResolvedValue({ id: "metric-1" });
    consumeFixedWindow.mockResolvedValue({ available: true, allowed: true, count: 1, limit: 30, retryAfterSeconds: 60, mode: "redis-url" });
  });

  afterEach(() => vi.unstubAllEnvs());

  it("records only sanitized click data and redirects to an allowed HTTPS destination", async () => {
    const response = await call();
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(affiliateLink.destination);
    expect(prismaMock.click.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        affiliateLinkId: "link-1",
        publicationId: "publication-1",
        channelId: "channel-1",
        referer: null,
        userAgent: null,
        refererHost: "origin.example",
        userAgentCategory: "MOBILE",
        fingerprintHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    });
    const data = prismaMock.click.create.mock.calls[0]?.[0]?.data;
    expect(JSON.stringify(data)).not.toContain("203.0.113.10");
    expect(JSON.stringify(data)).not.toContain("token=private");
  });

  it("returns 404 for a missing or inactive slug without exposing identifiers", async () => {
    prismaMock.affiliateLink.findUnique.mockResolvedValue(null);
    const missing = await call();
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe("Link indisponível.");
    prismaMock.affiliateLink.findUnique.mockResolvedValue({ ...affiliateLink, active: false });
    expect((await call()).status).toBe(404);
  });

  it.each([
    ["http://shopee.com.br/product/fixture", "HTTP"],
    ["https://shopee.com.br.evil.example/product", "lookalike"],
    ["not-a-url", "malformed"],
  ])("blocks an unsafe destination: %s (%s)", async (destination) => {
    prismaMock.affiliateLink.findUnique.mockResolvedValue({ ...affiliateLink, destination });
    const response = await call();
    expect(response.status).toBe(404);
    expect(prismaMock.click.create).not.toHaveBeenCalled();
    expect(consumeFixedWindow).not.toHaveBeenCalled();
  });

  it("continues the safe redirect when click persistence fails", async () => {
    prismaMock.click.create.mockRejectedValue(new Error("database unavailable with token=private"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = await call();
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(affiliateLink.destination);
    expect(JSON.stringify(warning.mock.calls)).not.toContain("private");
    warning.mockRestore();
  });

  it("redirects without persisting when Redis is unavailable", async () => {
    consumeFixedWindow.mockResolvedValue({ available: false, allowed: false, errorCode: "REDIS_UNAVAILABLE" });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = await call();
    expect(response.status).toBe(302);
    expect(prismaMock.click.create).not.toHaveBeenCalled();
    expect(prismaMock.trackingDailyMetric.upsert).toHaveBeenCalled();
    warning.mockRestore();
  });

  it.each([0, 1])("rate limits independently at limiter position %s", async (blockedIndex) => {
    consumeFixedWindow.mockImplementation(async (_key: string, limit: number) => {
      const current = consumeFixedWindow.mock.calls.length - 1;
      return { available: true, allowed: current !== blockedIndex, count: 999, limit };
    });
    const response = await call();
    expect(response.status).toBe(302);
    expect(prismaMock.click.create).not.toHaveBeenCalled();
  });

  it("deduplicates an immediate refresh", async () => {
    consumeFixedWindow
      .mockResolvedValueOnce({ available: true, allowed: true })
      .mockResolvedValueOnce({ available: true, allowed: true })
      .mockResolvedValueOnce({ available: true, allowed: false });
    expect((await call()).status).toBe(302);
    expect(prismaMock.click.create).not.toHaveBeenCalled();
  });

  it("degrades safely when the fingerprint secret is missing or invalid", async () => {
    vi.stubEnv("TRACKING_FINGERPRINT_SECRET", "short");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect((await call()).status).toBe(302);
    expect(consumeFixedWindow).not.toHaveBeenCalled();
    expect(prismaMock.click.create).not.toHaveBeenCalled();
    expect(JSON.stringify(warning.mock.calls)).not.toContain("short");
    warning.mockRestore();
  });

  it("keeps different clients separate without persisting raw addresses", async () => {
    await call({ ip: "203.0.113.10" });
    await call({ ip: "203.0.113.11" });
    const first = prismaMock.click.create.mock.calls[0]?.[0]?.data.fingerprintHash;
    const second = prismaMock.click.create.mock.calls[1]?.[0]?.data.fingerprintHash;
    expect(first).not.toBe(second);
    expect(JSON.stringify(prismaMock.click.create.mock.calls)).not.toMatch(/203\.0\.113\./);
  });

  it("does not guess a Publication when the Offer has multiple candidates", async () => {
    prismaMock.publication.findMany.mockResolvedValue([
      { id: "publication-1", channelId: "channel-1" },
      { id: "publication-2", channelId: "channel-2" },
    ]);
    await call();
    expect(prismaMock.click.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ publicationId: null, channelId: null }),
    });
  });
});
