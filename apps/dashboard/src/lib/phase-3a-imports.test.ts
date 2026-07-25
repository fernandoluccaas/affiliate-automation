import { beforeEach, describe, expect, it, vi } from "vitest";

const redirectMock = vi.fn((url: string) => {
  throw new Error(`REDIRECT:${url}`);
});
const findMarketplaceAccount = vi.fn();
const findDiscoveryConfig = vi.fn();
const createDiscoveryConfig = vi.fn();
const updateDiscoveryConfig = vi.fn();
const createMercadoLivreConnector = vi.fn();
const getMercadoLivreConfig = vi.fn();
const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

class MercadoLivreApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

vi.mock("server-only", () => ({}));

vi.mock("./session", () => ({
  createSession: vi.fn(),
  destroySession: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: redirectMock,
}));

vi.mock("@affiliate/database", () => ({
  Prisma: { JsonNull: {} },
  prisma: {
    marketplaceAccount: {
      findFirst: findMarketplaceAccount,
    },
    mercadoLivreDiscoveryConfig: {
      findFirst: findDiscoveryConfig,
      create: createDiscoveryConfig,
      update: updateDiscoveryConfig,
    },
  },
}));

vi.mock("@affiliate/marketplace-connectors", () => ({
  MercadoLivreApiError,
  createMercadoLivreConnector,
  getMercadoLivreConfig,
}));

describe("phase 3a imports", () => {
  beforeEach(() => {
    redirectMock.mockClear();
    consoleError.mockClear();
    findMarketplaceAccount.mockReset();
    findDiscoveryConfig.mockReset();
    createDiscoveryConfig.mockReset();
    updateDiscoveryConfig.mockReset();
    createMercadoLivreConnector.mockReset();
    getMercadoLivreConfig.mockReturnValue({
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "http://localhost:3000/api/integrations/mercadolivre/callback",
      siteId: "MLB",
    });
  });

  it("imports dashboard actions through the public ingestion package", async () => {
    const actions = await import("./actions");

    expect(typeof actions.createManualOfferAction).toBe("function");
    expect(typeof actions.saveMercadoLivreAffiliateUrlAction).toBe("function");
    expect(typeof actions.testMercadoLivreIntegrationAction).toBe("function");
    expect(typeof actions.syncMercadoLivreNowAction).toBe("function");
  });

  it("keeps ingestion exports available from the public package", async () => {
    const ingestion = await import("@affiliate/ingestion");

    expect(typeof ingestion.ingestOffer).toBe("function");
    expect(typeof ingestion.offerFormSchema.safeParse).toBe("function");
    expect(typeof ingestion.formatOfferFormError).toBe("function");
  });

  it("distinguishes Mercado Livre disconnected accounts from internal errors", async () => {
    const { testMercadoLivreIntegrationAction } = await import("./actions");
    findMarketplaceAccount.mockResolvedValueOnce(null);

    await expect(testMercadoLivreIntegrationAction()).rejects.toThrow(
      "REDIRECT:/integracoes?message=meli-not-connected",
    );
  });

  it("does not report connected-account internal errors as not connected", async () => {
    const { testMercadoLivreIntegrationAction } = await import("./actions");
    findMarketplaceAccount.mockResolvedValueOnce({ status: "CONNECTED" });
    createMercadoLivreConnector.mockRejectedValueOnce(new Error("Unexpected internal import failure."));

    await expect(testMercadoLivreIntegrationAction()).rejects.toThrow(
      "REDIRECT:/integracoes?message=meli-internal-error",
    );
  });

  it("distinguishes Mercado Livre auth errors from API availability errors", async () => {
    const { testMercadoLivreIntegrationAction } = await import("./actions");
    findMarketplaceAccount.mockResolvedValueOnce({ status: "CONNECTED" });
    createMercadoLivreConnector.mockRejectedValueOnce(new MercadoLivreApiError("Unauthorized", 401));

    await expect(testMercadoLivreIntegrationAction()).rejects.toThrow(
      "REDIRECT:/integracoes?message=meli-auth-error",
    );
  });

  it("runs the Mercado Livre test action without import failures", async () => {
    const { testMercadoLivreIntegrationAction } = await import("./actions");
    findMarketplaceAccount.mockResolvedValueOnce({ status: "CONNECTED" });
    createMercadoLivreConnector.mockResolvedValueOnce({
      healthCheck: vi.fn().mockResolvedValue(true),
    });

    await expect(testMercadoLivreIntegrationAction()).rejects.toThrow("REDIRECT:/integracoes?message=meli-ok");
  });

  it("does not silently add a parent category for discovery", async () => {
    const { addMercadoLivreCategoryAction } = await import("./actions");
    createMercadoLivreConnector.mockResolvedValueOnce({
      getCategory: vi.fn().mockResolvedValue({
        id: "MLB1055",
        name: "Eletronicos",
        pathFromRoot: [{ id: "MLB1055", name: "Eletronicos" }],
        children: [{ id: "MLB123", name: "Celulares" }],
      }),
    });

    const formData = new FormData();
    formData.set("categoryId", "MLB1055");

    await expect(addMercadoLivreCategoryAction(formData)).rejects.toThrow(
      "REDIRECT:/integracoes/mercado-livre?message=category-not-leaf&categoryId=MLB1055",
    );
    expect(createDiscoveryConfig).not.toHaveBeenCalled();
    expect(updateDiscoveryConfig).not.toHaveBeenCalled();
  });

  it("saves a leaf category correctly", async () => {
    const { addMercadoLivreCategoryAction } = await import("./actions");
    findDiscoveryConfig.mockResolvedValueOnce(null);
    createMercadoLivreConnector.mockResolvedValueOnce({
      getCategory: vi.fn().mockResolvedValue({
        id: "MLB123",
        name: "Celulares",
        pathFromRoot: [
          { id: "MLB1055", name: "Eletronicos" },
          { id: "MLB123", name: "Celulares" },
        ],
        children: [],
      }),
    });

    const formData = new FormData();
    formData.set("categoryId", "MLB123");

    await expect(addMercadoLivreCategoryAction(formData)).rejects.toThrow(
      "REDIRECT:/integracoes/mercado-livre?message=category-added&categoryId=MLB123",
    );
    expect(createDiscoveryConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          categoryIds: ["MLB123"],
          bestSellersEnabled: true,
        }),
      }),
    );
  });

  it("validates manual category IDs before saving configuration", async () => {
    const { saveMercadoLivreConfigAction } = await import("./actions");
    createMercadoLivreConnector.mockResolvedValueOnce({
      getCategory: vi.fn().mockResolvedValue({
        id: "MLB1055",
        name: "Eletronicos",
        pathFromRoot: [{ id: "MLB1055", name: "Eletronicos" }],
        children: [{ id: "MLB123", name: "Celulares" }],
      }),
    });

    const formData = new FormData();
    formData.set("siteId", "MLB");
    formData.set("categoryIds", "MLB1055");
    formData.set("bestSellersEnabled", "on");
    formData.set("minimumScore", "70");
    formData.set("maxCandidatesPerCategory", "5");
    formData.set("refreshIntervalMinutes", "360");

    await expect(saveMercadoLivreConfigAction(formData)).rejects.toThrow(
      "REDIRECT:/integracoes/mercado-livre?message=category-not-leaf&categoryId=MLB1055",
    );
  });
});
