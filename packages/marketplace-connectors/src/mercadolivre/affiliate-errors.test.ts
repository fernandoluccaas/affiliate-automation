import { describe, expect, it } from "vitest";
import {
  MercadoLivreAffiliateApiError,
  isMercadoLivreAffiliateApiError,
  sanitizeMercadoLivreAffiliateError,
} from "./affiliate-errors";

describe("MercadoLivreAffiliateApiError", () => {
  it.each([401, 403])(
    "classifies HTTP %s as an expired non-retryable session",
    (status) => {
      const error = new MercadoLivreAffiliateApiError(
        `HTTP ${status} while validating the affiliate session.`,
        {
          stage: "TAGS",
          status,
        },
      );

      expect(error).toMatchObject({
        status,
        stage: "TAGS",
        retryable: false,
        sessionExpired: true,
        productIneligible: false,
      });
    },
  );

  it.each([429, 500, 503])("classifies HTTP %s as retryable", (status) => {
    const error = new MercadoLivreAffiliateApiError(
      `HTTP ${status} while generating an affiliate link.`,
      {
        stage: "LINK_GENERATION",
        status,
      },
    );

    expect(error.retryable).toBe(true);
    expect(error.sessionExpired).toBe(false);
  });

  it("classifies code 111 as an ineligible product", () => {
    const error = new MercadoLivreAffiliateApiError(
      "The product is not eligible.",
      {
        stage: "LINK_GENERATION",
        status: 400,
        code: 111,
      },
    );

    expect(error).toMatchObject({
      retryable: false,
      sessionExpired: false,
      productIneligible: true,
    });
  });

  it("sanitizes headers, tokens, cookie strings and explicit secrets", () => {
    const explicitSecret = "synthetic-explicit-secret";
    const message = [
      "Authorization: Bearer synthetic-bearer",
      "Cookie: synthetic_session=synthetic-value; _csrf=synthetic-csrf",
      `detail=${explicitSecret}`,
    ].join("\n");
    const sanitized = sanitizeMercadoLivreAffiliateError(message, [
      explicitSecret,
    ]);

    expect(sanitized).not.toContain("synthetic-bearer");
    expect(sanitized).not.toContain("synthetic-value");
    expect(sanitized).not.toContain("synthetic-csrf");
    expect(sanitized).not.toContain(explicitSecret);
  });

  it("redacts a raw single-cookie value", () => {
    expect(
      sanitizeMercadoLivreAffiliateError(
        "synthetic_session=synthetic-private-value",
      ),
    ).toBe("[REDACTED]");
  });

  it("stores and serializes only sanitized error fields", () => {
    const error = new MercadoLivreAffiliateApiError(
      "Set-Cookie: synthetic_session=synthetic-value",
      {
        stage: "SESSION_WARMUP",
        status: 403,
        code: "synthetic-secret-code",
        secrets: ["synthetic-secret-code"],
      },
    );
    const serialized = error.toJSON();

    expect(isMercadoLivreAffiliateApiError(error)).toBe(true);
    expect(serialized).toMatchObject({
      name: "MercadoLivreAffiliateApiError",
      stage: "SESSION_WARMUP",
      status: 403,
      attempts: 1,
      sessionExpired: true,
    });
    expect(JSON.stringify(serialized)).not.toContain("synthetic-value");
    expect(JSON.stringify(serialized)).not.toContain("synthetic-secret-code");
  });

  it("allows explicit classification overrides after a handled refresh", () => {
    const error = new MercadoLivreAffiliateApiError(
      "HTTP 403 after a handled session refresh.",
      {
        stage: "LINK_GENERATION",
        status: 403,
        sessionExpired: false,
      },
    );

    expect(error.sessionExpired).toBe(false);
  });
});
