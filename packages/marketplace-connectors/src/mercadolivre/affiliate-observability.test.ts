import { describe, expect, it, vi } from "vitest";
import { emitMercadoLivreOperationalMetric } from "./affiliate-observability";

describe("Mercado Livre affiliate observability", () => {
  it("writes only the strict safe-field projection", () => {
    const write = vi.fn();

    emitMercadoLivreOperationalMetric(
      "mercadolivre_affiliate_link_failed",
      {
        jobId: "job-1",
        marketplaceAccountId: "account-1",
        externalItemId: "MLB123",
        stage: "LINK_GENERATION",
        durationMs: 12.9,
        status: "PENDING",
        attempt: 3,
        count: 1,
        errorCode: "HTTP_503",
        cookie: "sid=must-not-appear",
      } as never,
      write,
    );

    expect(JSON.parse(write.mock.calls[0]?.[0] as string)).toEqual({
      event: "mercadolivre_affiliate_link_failed",
      jobId: "job-1",
      marketplaceAccountId: "account-1",
      externalItemId: "MLB123",
      stage: "LINK_GENERATION",
      durationMs: 12,
      status: "PENDING",
      attempt: 3,
      count: 1,
      errorCode: "HTTP_503",
    });
    expect(write.mock.calls[0]?.[0]).not.toContain("must-not-appear");
  });

  it("sanitizes secret-shaped values in otherwise allowed fields", () => {
    const write = vi.fn();

    emitMercadoLivreOperationalMetric(
      "mercadolivre_affiliate_session_validation",
      {
        marketplaceAccountId: "Cookie: sid=secret-value",
        stage: "TAGS",
        status: "ERROR",
      },
      write,
    );

    expect(write.mock.calls[0]?.[0]).not.toContain("secret-value");
    expect(write.mock.calls[0]?.[0]).toContain("[REDACTED]");
  });
});
