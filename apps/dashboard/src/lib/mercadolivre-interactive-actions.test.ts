import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MercadoLivreDiscoveryConfigDto } from "@/app/integracoes/mercado-livre/mercado-livre-interactive-types";

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  browse: vi.fn(),
  testCategory: vi.fn(),
  addCategory: vi.fn(),
  saveConfig: vi.fn(),
}));

vi.mock("./session", () => ({ requireSession: mocks.requireSession }));
vi.mock("./mercadolivre-interactive-service", () => {
  class MercadoLivreInteractiveServiceError extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly fieldErrors?: Record<string, string>,
    ) {
      super(message);
    }
  }
  return {
    MercadoLivreInteractiveServiceError,
    getMercadoLivreCategoryBrowserData: mocks.browse,
    testMercadoLivreDiscoveryCategory: mocks.testCategory,
    addMercadoLivreDiscoveryCategory: mocks.addCategory,
    saveMercadoLivreDiscoveryConfig: mocks.saveConfig,
  };
});
vi.mock("./mercadolivre-interactive-diagnostics-service", () => ({
  diagnoseMercadoLivreProductInteractive: vi.fn(),
  diagnoseMercadoLivreProductPdpAffiliateInteractive: vi.fn(),
  probeMercadoLivreCategorySearchInteractive: vi.fn(),
}));

import {
  addMercadoLivreCategoryInteractiveAction,
  getMercadoLivreCategoryChildrenAction,
  saveMercadoLivreConfigInteractiveAction,
  testMercadoLivreCategoryInteractiveAction,
} from "./mercadolivre-interactive-actions";
import { MercadoLivreInteractiveServiceError } from "./mercadolivre-interactive-service";

const emptyConfig: MercadoLivreDiscoveryConfigDto = {
  enabled: false,
  siteId: "MLB",
  bestSellersEnabled: true,
  minimumPrice: "",
  maximumPrice: "",
  minimumDiscountPercentage: "",
  minimumScore: 0,
  maxCandidatesPerCategory: 20,
  refreshIntervalMinutes: 360,
  multiCategoryEnabled: false,
  multiCategoryMinOffersPerCategory: 1,
  multiCategoryMaxOffersPerCategory: 2,
  multiCategoryMaxTotalPerSession: 12,
  multiCategorySelectionMode: "ROUND_ROBIN",
  multiCategoryAllowCategoryBackfill: false,
  categories: [],
};

describe("Mercado Livre interactive server actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireSession.mockResolvedValue({ id: "admin", role: "ADMIN" });
  });

  it("serializes category browsing success", async () => {
    mocks.browse.mockResolvedValue({
      currentCategory: null,
      children: [],
      configuredCategories: [],
    });
    await expect(
      getMercadoLivreCategoryChildrenAction({ categoryId: null }),
    ).resolves.toEqual({
      ok: true,
      data: {
        currentCategory: null,
        children: [],
        configuredCategories: [],
      },
      message: "Categorias atualizadas.",
    });
  });

  it("returns a sanitized typed service error", async () => {
    mocks.browse.mockRejectedValue(
      new MercadoLivreInteractiveServiceError(
        "CATEGORY_API_ERROR",
        "Não foi possível consultar esta categoria.",
      ),
    );
    await expect(
      getMercadoLivreCategoryChildrenAction({ categoryId: "MLB-X" }),
    ).resolves.toEqual({
      ok: false,
      errorCode: "CATEGORY_API_ERROR",
      message: "Não foi possível consultar esta categoria.",
    });
  });

  it("fails closed for viewers", async () => {
    mocks.requireSession.mockResolvedValue({ id: "viewer", role: "VIEWER" });
    const result = await addMercadoLivreCategoryInteractiveAction({
      categoryId: "MLB-X",
    });
    expect(result).toMatchObject({ ok: false, errorCode: "NOT_AUTHORIZED" });
    expect(mocks.addCategory).not.toHaveBeenCalled();
  });

  it("rejects malformed input before the service call", async () => {
    const result = await testMercadoLivreCategoryInteractiveAction({
      categoryId: "",
    });
    expect(result).toMatchObject({
      ok: false,
      errorCode: "INPUT_INVALID",
    });
    expect(mocks.testCategory).not.toHaveBeenCalled();
  });

  it("reports idempotent category addition", async () => {
    mocks.addCategory.mockResolvedValue({
      category: { id: "MLB-X" },
      alreadyConfigured: true,
      configuredCategories: [],
    });
    const result = await addMercadoLivreCategoryInteractiveAction({
      categoryId: "MLB-X",
    });
    expect(result).toMatchObject({
      ok: true,
      message: "Categoria já adicionada.",
    });
  });

  it("returns the saved config without a redirect payload", async () => {
    mocks.saveConfig.mockResolvedValue(emptyConfig);
    const result = await saveMercadoLivreConfigInteractiveAction(
      new FormData(),
    );
    expect(result).toEqual({
      ok: true,
      data: emptyConfig,
      message: "Configuração salva.",
    });
  });
});
