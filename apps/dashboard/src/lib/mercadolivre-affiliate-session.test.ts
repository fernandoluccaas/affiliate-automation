import { beforeEach, describe, expect, it, vi } from "vitest";
import { MercadoLivreAffiliateApiError } from "@affiliate/marketplace-connectors";

vi.mock("server-only", () => ({}));

import {
  clearMercadoLivreAffiliateSession,
  generateMercadoLivreAffiliateTestLink,
  saveMercadoLivreAffiliateSession,
  selectMercadoLivreAffiliateTag,
  testMercadoLivreAffiliateSession,
  type MercadoLivreAffiliateSessionDependencies,
} from "./mercadolivre-affiliate-session";

const accountId = "marketplace-account-1";
const now = new Date("2026-07-28T14:30:00.000Z");
const findMarketplaceAccount = vi.fn();
const updateMarketplaceAccount = vi.fn();
const findAffiliateSession = vi.fn();
const upsertAffiliateSession = vi.fn();
const updateAffiliateSession = vi.fn();
const updateManyAffiliateSessions = vi.fn();
const deleteAffiliateSessions = vi.fn();
const validateSession = vi.fn();
const createAffiliateLink = vi.fn();
const encrypt = vi.fn((value: string) => `encrypted<${value}>`);
const decrypt = vi.fn((value: string) => value);
const monotonicNow = vi.fn(() => 100);
const emitOperationalMetric = vi.fn();

const database = {
  marketplaceAccount: {
    findFirst: findMarketplaceAccount,
    update: updateMarketplaceAccount,
  },
  mercadoLivreAffiliateSession: {
    findUnique: findAffiliateSession,
    upsert: upsertAffiliateSession,
    update: updateAffiliateSession,
    updateMany: updateManyAffiliateSessions,
    deleteMany: deleteAffiliateSessions,
  },
} as unknown as MercadoLivreAffiliateSessionDependencies["database"];

function tags() {
  return [
    {
      id: "tag-id-primary",
      value: "tag-primary",
      label: "Principal",
      isDefault: true,
    },
    {
      id: "tag-id-secondary",
      value: "tag-secondary",
      label: "Secundaria",
      isDefault: false,
    },
  ];
}

function dependencies(): Partial<MercadoLivreAffiliateSessionDependencies> {
  return {
    database,
    createSessionService: () => ({ validateSession }),
    createLinkService: () => ({ create: createAffiliateLink }),
    encrypt,
    decrypt,
    now: () => now,
    monotonicNow,
    emitOperationalMetric,
  };
}

beforeEach(() => {
  findMarketplaceAccount.mockReset();
  updateMarketplaceAccount.mockReset();
  findAffiliateSession.mockReset();
  upsertAffiliateSession.mockReset();
  updateAffiliateSession.mockReset();
  updateManyAffiliateSessions.mockReset();
  deleteAffiliateSessions.mockReset();
  validateSession.mockReset();
  createAffiliateLink.mockReset();
  encrypt.mockClear();
  decrypt.mockReset();
  monotonicNow.mockReset();
  monotonicNow.mockReturnValue(100);
  emitOperationalMetric.mockReset();

  findMarketplaceAccount.mockResolvedValue({ id: accountId });
  findAffiliateSession.mockResolvedValue(null);
  upsertAffiliateSession.mockResolvedValue({});
  updateAffiliateSession.mockResolvedValue({});
  deleteAffiliateSessions.mockResolvedValue({ count: 1 });
  decrypt.mockImplementation((value: string) => value);
});

describe("Mercado Livre affiliate session use cases", () => {
  it("encrypts a valid cookie, persists safe tags, and never returns secrets", async () => {
    const normalizedCookie =
      "session-id=valid-session; XSRF-TOKEN=csrf%20token";
    const availableTags = tags();
    validateSession.mockResolvedValue({
      cookie: normalizedCookie,
      csrfToken: "csrf token",
      tags: availableTags,
      selectedTag: availableTags[0],
    });

    const result = await saveMercadoLivreAffiliateSession(
      {
        cookie: " session-id = valid-session ; XSRF-TOKEN=csrf%20token ; ",
        affiliateTag: "tag-primary",
      },
      dependencies(),
    );

    expect(validateSession).toHaveBeenCalledWith({
      cookie: normalizedCookie,
      csrfToken: null,
      preferredTag: "tag-primary",
    });
    expect(upsertAffiliateSession).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { marketplaceAccountId: accountId },
        create: expect.objectContaining({
          marketplaceAccountId: accountId,
          cookieEncrypted: `encrypted<${normalizedCookie}>`,
          csrfTokenEncrypted: null,
          status: "VALIDATING",
        }),
      }),
    );
    expect(updateAffiliateSession).toHaveBeenLastCalledWith({
      where: { marketplaceAccountId: accountId },
      data: expect.objectContaining({
        affiliateTag: "tag-primary",
        availableTags,
        cookieEncrypted: `encrypted<${normalizedCookie}>`,
        csrfTokenEncrypted: "encrypted<csrf token>",
        status: "CONNECTED",
        lastValidatedAt: now,
      }),
    });
    expect(result).toEqual({
      ok: true,
      code: "SAVED",
      status: "CONNECTED",
      affiliateTag: "tag-primary",
      availableTags,
    });
    expect(result).not.toHaveProperty("cookie");
    expect(result).not.toHaveProperty("cookieEncrypted");
    expect(result).not.toHaveProperty("csrfToken");
    expect(result).not.toHaveProperty("csrfTokenEncrypted");
    expect(JSON.stringify(result)).not.toContain("valid-session");
    expect(JSON.stringify(result)).not.toContain("csrf token");
    expect(emitOperationalMetric).toHaveBeenCalledWith(
      "mercadolivre_affiliate_session_validation",
      expect.objectContaining({
        marketplaceAccountId: accountId,
        stage: "SESSION_VALIDATION",
        durationMs: 0,
        status: "CONNECTED",
        count: 1,
      }),
    );
  });

  it("preserves the stored cookie and cookie timestamp when an empty replacement is submitted", async () => {
    const storedCookie = "session-id=stored-session";
    const storedCookieUpdatedAt = new Date("2026-07-20T10:00:00.000Z");
    const availableTags = tags();
    findAffiliateSession.mockResolvedValue({
      cookieEncrypted: "vault-cookie",
      csrfTokenEncrypted: "vault-csrf",
      affiliateTag: "tag-primary",
      lastCookieUpdateAt: storedCookieUpdatedAt,
    });
    decrypt.mockImplementation((value: string) => {
      if (value === "vault-cookie") return storedCookie;
      if (value === "vault-csrf") return "stored-csrf";
      throw new Error("Unexpected encrypted value.");
    });
    validateSession.mockResolvedValue({
      cookie: storedCookie,
      csrfToken: "stored-csrf",
      tags: availableTags,
      selectedTag: availableTags[0],
    });

    const result = await saveMercadoLivreAffiliateSession(
      { cookie: "", affiliateTag: "" },
      dependencies(),
    );

    expect(validateSession).toHaveBeenCalledWith({
      cookie: storedCookie,
      csrfToken: "stored-csrf",
      preferredTag: "tag-primary",
    });
    expect(upsertAffiliateSession).toHaveBeenCalledWith(
      expect.objectContaining({
        update: {
          sampleAffiliateLink: null,
          affiliateTag: "tag-primary",
          status: "VALIDATING",
          lastErrorAt: null,
          lastError: null,
        },
      }),
    );
    expect(updateAffiliateSession).toHaveBeenLastCalledWith({
      where: { marketplaceAccountId: accountId },
      data: expect.not.objectContaining({
        lastCookieUpdateAt: now,
      }),
    });
    expect(encrypt).not.toHaveBeenCalledWith("");
    expect(result).toMatchObject({
      ok: true,
      code: "SAVED",
      status: "CONNECTED",
    });
  });

  it("generates a real test link and persists only rotated encrypted session values", async () => {
    findAffiliateSession.mockResolvedValue({
      status: "CONNECTED",
      cookieEncrypted: "session=opaque",
      csrfTokenEncrypted: "csrf=opaque",
      affiliateTag: "tag-primary",
      updatedAt: new Date("2026-07-28T14:00:00.000Z"),
    });
    decrypt.mockImplementation((value: string) =>
      value === "session=opaque" ? "session=valid" : "csrf-valid",
    );
    createAffiliateLink.mockResolvedValue({
      affiliateUrl: "https://meli.la/real-test",
      refreshedCookie: "session=rotated",
      refreshedCsrfToken: "csrf-rotated",
    });
    updateManyAffiliateSessions.mockResolvedValue({ count: 1 });

    const result = await generateMercadoLivreAffiliateTestLink(
      {
        productUrl: "https://produto.mercadolivre.com.br/MLB-123456789-produto",
        affiliateTag: "tag-primary",
      },
      dependencies(),
    );

    expect(result).toMatchObject({
      ok: true,
      code: "LINK_GENERATED",
      affiliateUrl: "https://meli.la/real-test",
      provider: "stripe_v2",
      generatedAt: now,
    });
    expect(updateManyAffiliateSessions).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          marketplaceAccountId: accountId,
        }),
        data: expect.objectContaining({
          cookieEncrypted: "encrypted<session=rotated>",
          csrfTokenEncrypted: "encrypted<csrf-rotated>",
        }),
      }),
    );
    expect(JSON.stringify(result)).not.toContain("session=rotated");
    expect(JSON.stringify(result)).not.toContain("csrf-rotated");
  });

  it("lets a new cookie recover a session without decrypting stale CSRF", async () => {
    const availableTags = tags();
    findAffiliateSession.mockResolvedValue({
      cookieEncrypted: "old-cookie-ciphertext",
      csrfTokenEncrypted: "corrupt-csrf-ciphertext",
      affiliateTag: "tag-primary",
      lastCookieUpdateAt: now,
    });
    decrypt.mockImplementation(() => {
      throw new Error("Corrupt stored ciphertext.");
    });
    validateSession.mockResolvedValue({
      cookie: "session-id=replacement",
      csrfToken: "new-csrf",
      tags: availableTags,
      selectedTag: availableTags[0],
    });

    const result = await saveMercadoLivreAffiliateSession(
      { cookie: "session-id=replacement" },
      dependencies(),
    );

    expect(result).toMatchObject({
      ok: true,
      status: "CONNECTED",
    });
    expect(decrypt).not.toHaveBeenCalled();
    expect(validateSession).toHaveBeenCalledWith({
      cookie: "session-id=replacement",
      csrfToken: null,
      preferredTag: "tag-primary",
    });
  });

  it("marks a corrupt stored credential as ERROR without exposing it", async () => {
    findAffiliateSession.mockResolvedValue({
      cookieEncrypted: "corrupt-cookie-ciphertext",
      csrfTokenEncrypted: null,
      affiliateTag: "tag-primary",
      lastCookieUpdateAt: now,
    });
    decrypt.mockImplementation(() => {
      throw new Error("ciphertext contains internal detail");
    });

    const result = await saveMercadoLivreAffiliateSession(
      { cookie: "" },
      dependencies(),
    );

    expect(result).toEqual({
      ok: false,
      code: "ERROR",
      status: "ERROR",
      errorMessage: "Mercado Livre affiliate operation failed.",
    });
    expect(updateAffiliateSession).toHaveBeenCalledWith({
      where: { marketplaceAccountId: accountId },
      data: {
        status: "ERROR",
        lastErrorAt: now,
        lastError: "Mercado Livre affiliate operation failed.",
      },
    });
    expect(validateSession).not.toHaveBeenCalled();
  });

  it("rejects an arbitrary reference URL before changing session state", async () => {
    const result = await saveMercadoLivreAffiliateSession(
      {
        cookie: "session-id=valid",
        sampleAffiliateLink: "https://example.com/not-mercado-livre",
      },
      dependencies(),
    );

    expect(result).toEqual({
      ok: false,
      code: "INVALID_INPUT",
      status: "ERROR",
    });
    expect(upsertAffiliateSession).not.toHaveBeenCalled();
    expect(validateSession).not.toHaveBeenCalled();
  });

  it("persists cookie and CSRF refreshed while testing the reference product", async () => {
    const availableTags = tags();
    validateSession.mockResolvedValue({
      cookie: "session-id=warmed",
      csrfToken: "csrf-warmed",
      tags: availableTags,
      selectedTag: availableTags[0],
    });
    createAffiliateLink.mockResolvedValue({
      affiliateUrl: "https://meli.la/AbC123",
      refreshedCookie: "session-id=rotated",
      refreshedCsrfToken: "csrf-rotated",
    });

    await saveMercadoLivreAffiliateSession(
      {
        cookie: "session-id=initial",
        sampleAffiliateLink:
          "https://produto.mercadolivre.com.br/MLB-123456789",
      },
      dependencies(),
    );

    expect(createAffiliateLink).toHaveBeenCalledWith({
      productUrl: "https://produto.mercadolivre.com.br/MLB-123456789",
      affiliateTag: "tag-primary",
      cookie: "session-id=warmed",
      csrfToken: "csrf-warmed",
    });
    expect(updateAffiliateSession).toHaveBeenLastCalledWith({
      where: { marketplaceAccountId: accountId },
      data: expect.objectContaining({
        cookieEncrypted: "encrypted<session-id=rotated>",
        csrfTokenEncrypted: "encrypted<csrf-rotated>",
        lastCookieUpdateAt: now,
        status: "CONNECTED",
      }),
    });
  });

  it.each([401, 403])(
    "marks only the affiliate session EXPIRED after HTTP %s",
    async (status) => {
      findAffiliateSession.mockResolvedValue({
        cookieEncrypted: "vault-cookie",
        csrfTokenEncrypted: null,
        affiliateTag: "tag-primary",
      });
      decrypt.mockReturnValue("session-id=stored-session");
      validateSession.mockRejectedValue(
        new MercadoLivreAffiliateApiError(
          "Mercado Livre affiliate session is expired.",
          { stage: "TAGS", status },
        ),
      );

      const result = await testMercadoLivreAffiliateSession(dependencies());

      expect(result).toMatchObject({
        ok: false,
        code: "EXPIRED",
        status: "EXPIRED",
      });
      expect(updateAffiliateSession).toHaveBeenLastCalledWith({
        where: { marketplaceAccountId: accountId },
        data: expect.objectContaining({
          status: "EXPIRED",
          lastErrorAt: now,
        }),
      });
      expect(updateMarketplaceAccount).not.toHaveBeenCalled();
      expect(emitOperationalMetric).toHaveBeenCalledWith(
        "mercadolivre_affiliate_session_validation",
        expect.objectContaining({
          marketplaceAccountId: accountId,
          status: "EXPIRED",
          errorCode: "EXPIRED",
        }),
      );
      expect(emitOperationalMetric).toHaveBeenCalledWith(
        "mercadolivre_affiliate_session_expired",
        expect.objectContaining({
          marketplaceAccountId: accountId,
          status: "EXPIRED",
          count: 1,
        }),
      );
    },
  );

  it("stores and returns only a sanitized non-authentication error", async () => {
    const secret = "session-id=top-secret; csrf-token=hidden";
    findAffiliateSession.mockResolvedValue({
      cookieEncrypted: "vault-cookie",
      csrfTokenEncrypted: null,
      affiliateTag: "tag-primary",
    });
    decrypt.mockReturnValue("session-id=stored-session");
    validateSession.mockRejectedValue(new Error(`Cookie: ${secret}`));

    const result = await testMercadoLivreAffiliateSession(dependencies());

    expect(result).toMatchObject({
      ok: false,
      code: "ERROR",
      status: "ERROR",
    });
    expect(result.errorMessage).not.toContain("top-secret");
    expect(result.errorMessage).not.toContain("hidden");
    expect(updateAffiliateSession).toHaveBeenLastCalledWith({
      where: { marketplaceAccountId: accountId },
      data: expect.objectContaining({
        status: "ERROR",
        lastErrorAt: now,
        lastError: expect.not.stringContaining("top-secret"),
      }),
    });
    expect(updateMarketplaceAccount).not.toHaveBeenCalled();
  });

  it("tests an existing connection and persists refreshed session values", async () => {
    const availableTags = tags();
    findAffiliateSession.mockResolvedValue({
      cookieEncrypted: "vault-cookie",
      csrfTokenEncrypted: "vault-csrf",
      affiliateTag: "tag-secondary",
    });
    decrypt.mockImplementation((value: string) =>
      value === "vault-cookie" ? "session-id=stored" : "csrf-stored",
    );
    validateSession.mockResolvedValue({
      cookie: "session-id=refreshed",
      csrfToken: "csrf-refreshed",
      tags: availableTags,
      selectedTag: availableTags[1],
    });

    const result = await testMercadoLivreAffiliateSession(dependencies());

    expect(validateSession).toHaveBeenCalledWith({
      cookie: "session-id=stored",
      csrfToken: "csrf-stored",
      preferredTag: "tag-secondary",
    });
    expect(updateAffiliateSession).toHaveBeenLastCalledWith({
      where: { marketplaceAccountId: accountId },
      data: expect.objectContaining({
        affiliateTag: "tag-secondary",
        availableTags,
        cookieEncrypted: "encrypted<session-id=refreshed>",
        csrfTokenEncrypted: "encrypted<csrf-refreshed>",
        status: "CONNECTED",
        lastValidatedAt: now,
        lastCookieUpdateAt: now,
      }),
    });
    expect(result).toEqual({
      ok: true,
      code: "TESTED",
      status: "CONNECTED",
      affiliateTag: "tag-secondary",
      availableTags,
    });
  });

  it("clears only the affiliate session for the Mercado Livre account", async () => {
    const result = await clearMercadoLivreAffiliateSession(dependencies());

    expect(deleteAffiliateSessions).toHaveBeenCalledWith({
      where: { marketplaceAccountId: accountId },
    });
    expect(updateMarketplaceAccount).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      code: "CLEARED",
      status: "NOT_CONFIGURED",
    });
  });

  it("selects a listed tag by id and persists its canonical value", async () => {
    const availableTags = tags();
    findAffiliateSession.mockResolvedValue({
      availableTags,
      status: "CONNECTED",
    });

    const result = await selectMercadoLivreAffiliateTag(
      " tag-id-secondary ",
      dependencies(),
    );

    expect(updateAffiliateSession).toHaveBeenCalledWith({
      where: { marketplaceAccountId: accountId },
      data: { affiliateTag: "tag-secondary" },
    });
    expect(result).toEqual({
      ok: true,
      code: "TAG_SELECTED",
      status: "CONNECTED",
      affiliateTag: "tag-secondary",
      availableTags,
    });
  });

  it.each(["", "unknown-tag"])(
    "rejects an unavailable affiliate tag %j without persistence",
    async (affiliateTag) => {
      findAffiliateSession.mockResolvedValue({
        availableTags: tags(),
        status: "CONNECTED",
      });

      const result = await selectMercadoLivreAffiliateTag(
        affiliateTag,
        dependencies(),
      );

      expect(result).toEqual({
        ok: false,
        code: "INVALID_INPUT",
        status: "ERROR",
      });
      expect(updateAffiliateSession).not.toHaveBeenCalled();
    },
  );
});
