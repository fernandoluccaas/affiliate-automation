import { beforeEach, describe, expect, it, vi } from "vitest";

const redirectMock = vi.fn((url: string): never => {
  throw new Error(`REDIRECT:${url}`);
});
const revalidatePathMock = vi.fn();
const requireSessionMock = vi.fn();
const saveAffiliateSessionMock = vi.fn();
const testAffiliateSessionMock = vi.fn();
const clearAffiliateSessionMock = vi.fn();
const selectAffiliateTagMock = vi.fn();
const generatePendingAffiliateLinksMock = vi.fn();

vi.mock("server-only", () => ({}));

vi.mock("next/cache", () => ({
  revalidatePath: revalidatePathMock,
}));

vi.mock("next/navigation", () => ({
  redirect: redirectMock,
}));

vi.mock("./session", () => ({
  requireSession: requireSessionMock,
}));

vi.mock("./mercadolivre-affiliate-session", () => ({
  saveMercadoLivreAffiliateSession: saveAffiliateSessionMock,
  testMercadoLivreAffiliateSession: testAffiliateSessionMock,
  clearMercadoLivreAffiliateSession: clearAffiliateSessionMock,
  selectMercadoLivreAffiliateTag: selectAffiliateTagMock,
}));

vi.mock("@affiliate/marketplace-discovery", () => ({
  generatePendingMercadoLivreAffiliateLinks: generatePendingAffiliateLinksMock,
}));

function saveForm(overrides: Record<string, string> = {}) {
  const formData = new FormData();
  formData.set(
    "sampleAffiliateLink",
    overrides.sampleAffiliateLink ??
      "https://produto.mercadolivre.com.br/MLB-123456789",
  );
  formData.set("cookie", overrides.cookie ?? "session-id=valid");
  formData.set("affiliateTag", overrides.affiliateTag ?? "tag-primary");
  return formData;
}

function tagForm(value = "tag-primary") {
  const formData = new FormData();
  formData.set("affiliateTag", value);
  return formData;
}

function limitForm(value = "50") {
  const formData = new FormData();
  formData.set("limit", value);
  return formData;
}

beforeEach(() => {
  redirectMock.mockClear();
  revalidatePathMock.mockReset();
  requireSessionMock.mockReset();
  saveAffiliateSessionMock.mockReset();
  testAffiliateSessionMock.mockReset();
  clearAffiliateSessionMock.mockReset();
  selectAffiliateTagMock.mockReset();
  generatePendingAffiliateLinksMock.mockReset();

  requireSessionMock.mockResolvedValue({
    id: "operator-1",
    email: "operator@example.com",
    role: "OPERATOR",
  });
  saveAffiliateSessionMock.mockResolvedValue({
    ok: true,
    code: "SAVED",
    status: "CONNECTED",
  });
  testAffiliateSessionMock.mockResolvedValue({
    ok: true,
    code: "TESTED",
    status: "CONNECTED",
  });
  clearAffiliateSessionMock.mockResolvedValue({
    ok: true,
    code: "CLEARED",
    status: "NOT_CONFIGURED",
  });
  selectAffiliateTagMock.mockResolvedValue({
    ok: true,
    code: "TAG_SELECTED",
    status: "CONNECTED",
    affiliateTag: "tag-primary",
  });
  generatePendingAffiliateLinksMock.mockResolvedValue({
    ok: true,
    status: "SUCCEEDED",
    selected: 25,
    processed: 25,
    linksGenerated: 25,
    updated: 25,
    ineligible: 0,
    pending: 0,
    failed: 0,
  });
});

describe("Mercado Livre affiliate server actions", () => {
  it("preprocesses empty optional values so saving preserves the cookie", async () => {
    const { saveMercadoLivreAffiliateSessionAction } =
      await import("./mercadolivre-affiliate-actions");
    const formData = saveForm({
      sampleAffiliateLink: "",
      cookie: "",
      affiliateTag: "",
    });

    await expect(
      saveMercadoLivreAffiliateSessionAction(formData),
    ).rejects.toThrow(
      "REDIRECT:/integracoes/mercado-livre?message=affiliate-session-saved",
    );
    expect(saveAffiliateSessionMock).toHaveBeenCalledWith({
      sampleAffiliateLink: undefined,
      cookie: undefined,
      affiliateTag: undefined,
    });
  });

  it("uses fixed redirects and fixed page revalidation after successful actions", async () => {
    const actions = await import("./mercadolivre-affiliate-actions");

    await expect(
      actions.saveMercadoLivreAffiliateSessionAction(saveForm()),
    ).rejects.toThrow(
      "REDIRECT:/integracoes/mercado-livre?message=affiliate-session-saved",
    );
    await expect(
      actions.testMercadoLivreAffiliateSessionAction(),
    ).rejects.toThrow(
      "REDIRECT:/integracoes/mercado-livre?message=affiliate-session-tested",
    );
    await expect(
      actions.clearMercadoLivreAffiliateSessionAction(),
    ).rejects.toThrow(
      "REDIRECT:/integracoes/mercado-livre?message=affiliate-session-cleared",
    );
    await expect(
      actions.selectMercadoLivreAffiliateTagAction(tagForm()),
    ).rejects.toThrow(
      "REDIRECT:/integracoes/mercado-livre?message=affiliate-tag-selected",
    );

    const redirectUrls = redirectMock.mock.calls.map(([url]) => url);
    expect(redirectUrls).toEqual([
      "/integracoes/mercado-livre?message=affiliate-session-saved",
      "/integracoes/mercado-livre?message=affiliate-session-tested",
      "/integracoes/mercado-livre?message=affiliate-session-cleared",
      "/integracoes/mercado-livre?message=affiliate-tag-selected",
    ]);
    expect(revalidatePathMock).toHaveBeenCalledTimes(16);
    for (const path of [
      "/integracoes",
      "/integracoes/mercado-livre",
      "/ofertas",
      "/ofertas/affiliate-links",
    ]) {
      expect(revalidatePathMock).toHaveBeenCalledWith(path);
    }
  });

  it.each([
    ["EXPIRED", "EXPIRED", "affiliate-session-expired"],
    ["ERROR", "ERROR", "affiliate-session-error"],
    ["INVALID_INPUT", "ERROR", "affiliate-session-invalid"],
  ])(
    "maps %s failures to a fixed sanitized redirect",
    async (code, status, message) => {
      const { saveMercadoLivreAffiliateSessionAction } =
        await import("./mercadolivre-affiliate-actions");
      saveAffiliateSessionMock.mockResolvedValueOnce({
        ok: false,
        code,
        status,
        errorMessage: "Cookie: session-id=must-never-leak",
      });

      await expect(
        saveMercadoLivreAffiliateSessionAction(saveForm()),
      ).rejects.toThrow(
        `REDIRECT:/integracoes/mercado-livre?message=${message}`,
      );
      expect(redirectMock.mock.calls.at(-1)?.[0]).not.toContain(
        "must-never-leak",
      );
    },
  );

  it("rejects invalid Zod input before calling the save use case", async () => {
    const { saveMercadoLivreAffiliateSessionAction } =
      await import("./mercadolivre-affiliate-actions");

    await expect(
      saveMercadoLivreAffiliateSessionAction(
        saveForm({ sampleAffiliateLink: "not-a-url" }),
      ),
    ).rejects.toThrow(
      "REDIRECT:/integracoes/mercado-livre?message=affiliate-session-invalid",
    );
    expect(saveAffiliateSessionMock).not.toHaveBeenCalled();
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it("accepts omitted optional fields and converts them to undefined", async () => {
    const { saveMercadoLivreAffiliateSessionAction } =
      await import("./mercadolivre-affiliate-actions");

    await expect(
      saveMercadoLivreAffiliateSessionAction(new FormData()),
    ).rejects.toThrow(
      "REDIRECT:/integracoes/mercado-livre?message=affiliate-session-saved",
    );
    expect(saveAffiliateSessionMock).toHaveBeenCalledWith({
      sampleAffiliateLink: undefined,
      cookie: undefined,
      affiliateTag: undefined,
    });
  });

  it("maps an unexpected use-case failure to a fixed safe redirect", async () => {
    const { saveMercadoLivreAffiliateSessionAction } =
      await import("./mercadolivre-affiliate-actions");
    saveAffiliateSessionMock.mockRejectedValueOnce(
      new Error("database connection contained internal details"),
    );

    await expect(
      saveMercadoLivreAffiliateSessionAction(saveForm()),
    ).rejects.toThrow(
      "REDIRECT:/integracoes/mercado-livre?message=affiliate-session-error",
    );
    expect(redirectMock.mock.calls.at(-1)?.[0]).not.toContain(
      "internal details",
    );
  });

  it("rejects an invalid tag and invalid pending limit through Zod", async () => {
    const actions = await import("./mercadolivre-affiliate-actions");

    await expect(
      actions.selectMercadoLivreAffiliateTagAction(tagForm("   ")),
    ).rejects.toThrow(
      "REDIRECT:/integracoes/mercado-livre?message=affiliate-session-invalid",
    );
    await expect(
      actions.generatePendingMercadoLivreAffiliateLinksAction(limitForm("51")),
    ).rejects.toThrow(
      "REDIRECT:/integracoes/mercado-livre?message=affiliate-session-invalid",
    );
    expect(selectAffiliateTagMock).not.toHaveBeenCalled();
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it("passes a trimmed valid tag to the selection use case", async () => {
    const { selectMercadoLivreAffiliateTagAction } =
      await import("./mercadolivre-affiliate-actions");

    await expect(
      selectMercadoLivreAffiliateTagAction(tagForm(" tag-primary ")),
    ).rejects.toThrow(
      "REDIRECT:/integracoes/mercado-livre?message=affiliate-tag-selected",
    );
    expect(selectAffiliateTagMock).toHaveBeenCalledWith("tag-primary");
  });

  it.each(["save", "test", "clear", "select", "pending"])(
    "blocks VIEWER before the %s action reaches a use case",
    async (actionName) => {
      const actions = await import("./mercadolivre-affiliate-actions");
      requireSessionMock.mockResolvedValueOnce({
        id: "viewer-1",
        email: "viewer@example.com",
        role: "VIEWER",
      });
      const invoke = {
        save: () => actions.saveMercadoLivreAffiliateSessionAction(saveForm()),
        test: () => actions.testMercadoLivreAffiliateSessionAction(),
        clear: () => actions.clearMercadoLivreAffiliateSessionAction(),
        select: () => actions.selectMercadoLivreAffiliateTagAction(tagForm()),
        pending: () =>
          actions.generatePendingMercadoLivreAffiliateLinksAction(limitForm()),
      }[actionName];

      await expect(invoke?.()).rejects.toThrow(
        "REDIRECT:/integracoes/mercado-livre?message=affiliate-not-authorized",
      );
      expect(saveAffiliateSessionMock).not.toHaveBeenCalled();
      expect(testAffiliateSessionMock).not.toHaveBeenCalled();
      expect(clearAffiliateSessionMock).not.toHaveBeenCalled();
      expect(selectAffiliateTagMock).not.toHaveBeenCalled();
      expect(generatePendingAffiliateLinksMock).not.toHaveBeenCalled();
      expect(revalidatePathMock).not.toHaveBeenCalled();
    },
  );

  it("runs bounded pending enrichment and reports success", async () => {
    const { generatePendingMercadoLivreAffiliateLinksAction } =
      await import("./mercadolivre-affiliate-actions");

    await expect(
      generatePendingMercadoLivreAffiliateLinksAction(limitForm("25")),
    ).rejects.toThrow(
      "REDIRECT:/integracoes/mercado-livre?message=affiliate-links-generated",
    );
    expect(generatePendingAffiliateLinksMock).toHaveBeenCalledWith({
      limit: 25,
      offerIds: [],
      dryRun: false,
    });
    expect(revalidatePathMock).toHaveBeenCalledTimes(4);
  });

  it.each([
    [
      {
        ok: true,
        status: "SUCCEEDED",
        selected: 0,
        processed: 0,
        linksGenerated: 0,
        updated: 0,
        ineligible: 0,
        pending: 0,
        failed: 0,
      },
      "affiliate-links-none",
    ],
    [
      {
        ok: true,
        status: "PARTIAL",
        selected: 4,
        processed: 4,
        linksGenerated: 2,
        updated: 2,
        ineligible: 1,
        pending: 1,
        failed: 0,
      },
      "affiliate-links-partial",
    ],
    [
      {
        ok: false,
        status: "FAILED",
        selected: 4,
        processed: 0,
        linksGenerated: 0,
        updated: 0,
        ineligible: 0,
        pending: 4,
        failed: 1,
        errorCode: "AFFILIATE_ENRICHMENT_FAILED",
        errorMessage: "internal detail",
      },
      "affiliate-session-error",
    ],
  ])(
    "maps pending enrichment outcomes to fixed message %s",
    async (result, message) => {
      const { generatePendingMercadoLivreAffiliateLinksAction } =
        await import("./mercadolivre-affiliate-actions");
      generatePendingAffiliateLinksMock.mockResolvedValueOnce(result);

      await expect(
        generatePendingMercadoLivreAffiliateLinksAction(limitForm("4")),
      ).rejects.toThrow(
        `REDIRECT:/integracoes/mercado-livre?message=${message}`,
      );
      expect(redirectMock.mock.calls.at(-1)?.[0]).not.toContain(
        "internal detail",
      );
    },
  );
});
