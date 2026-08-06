import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DiagnosticsPanel } from "./diagnostics-panel";

const actions = vi.hoisted(() => ({
  product: vi.fn(),
  probe: vi.fn(),
  pdp: vi.fn(),
}));

vi.mock("@/lib/mercadolivre-interactive-actions", () => ({
  diagnoseMercadoLivreProductInteractiveAction: actions.product,
  probeMercadoLivreCategorySearchInteractiveAction: actions.probe,
  testMercadoLivreProductPdpAffiliateInteractiveAction: actions.pdp,
}));

describe("DiagnosticsPanel", () => {
  beforeEach(() => vi.clearAllMocks());

  it("diagnoses a PRODUCT inline without navigation", async () => {
    actions.product.mockResolvedValue({
      ok: true,
      data: {
        productId: "MLB123",
        productFound: true,
        productStatus: "active",
        productName: "Produto sanitizado",
        productPermalink: null,
        resolvedProductUrl: "https://www.mercadolivre.com.br/p/MLB123",
        productUrlSource: "CANONICAL_CATALOG_PDP",
        productPictureCount: 1,
        buyBoxWinnerPresent: true,
        buyBoxWinnerItemId: "MLB999",
        selectedItemId: "MLB999",
        selectedSellerId: null,
        selectedPrice: "99.90",
        selectedFreeShipping: true,
        detailEnrichmentStatus: "AVAILABLE",
        pdpFallbackEligible: true,
        resolutionEligible: true,
        rejectionReasons: [],
        counts: {},
      },
      message: "Diagnóstico do PRODUCT concluído.",
    });
    const pathname = window.location.pathname;
    render(<DiagnosticsPanel />);
    fireEvent.change(screen.getByLabelText("PRODUCT ID"), {
      target: { value: "MLB123" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Diagnosticar PRODUCT" }),
    );

    expect(
      await screen.findByLabelText("Resultado do diagnóstico PRODUCT"),
    ).toHaveTextContent("MLB999");
    expect(window.location.pathname).toBe(pathname);
  });

  it("executes the category probe and keeps the initial deep-link id", async () => {
    actions.probe.mockResolvedValue({
      ok: true,
      data: {
        categoryId: "MLB-LEAF",
        categoryName: "Celulares",
        categoryPath: "Eletrônicos > Celulares",
        method: "GET",
        endpoint: "/sites/MLB/search",
        categoryParameter: "MLB-LEAF",
        limit: 5,
        diagnosis: "OK",
        authenticated: {
          attempted: true,
          ok: true,
          httpStatus: 200,
          resultsFound: 5,
          usableItems: 5,
          errorCode: null,
        },
        public: {
          attempted: false,
          ok: false,
          httpStatus: null,
          resultsFound: 0,
          usableItems: 0,
          errorCode: null,
        },
      },
      message: "Probe da categoria concluído.",
    });
    render(<DiagnosticsPanel initialCategoryId="MLB-LEAF" />);
    expect(screen.getByLabelText("Categoria folha")).toHaveValue("MLB-LEAF");
    fireEvent.click(
      screen.getByRole("button", { name: "Executar probe avançado" }),
    );
    expect(
      await screen.findByLabelText("Resultado do probe da categoria"),
    ).toHaveTextContent("Eletrônicos > Celulares");
  });

  it("tests the PRODUCT PDP affiliate path without exposing the generated URL", async () => {
    actions.pdp.mockResolvedValue({
      ok: true,
      data: {
        productId: "MLB123",
        endpointMode: "stripe_v2",
        affiliateHost: "meli.la",
        startsWithMeliLa: true,
        productUrlSource: "CANONICAL_CATALOG_PDP",
      },
      message: "Teste afiliado do PRODUCT concluído.",
    });
    render(<DiagnosticsPanel />);
    fireEvent.change(screen.getByLabelText("PRODUCT ID"), {
      target: { value: "MLB123" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Testar geração afiliada do PDP" }),
    );
    expect(
      await screen.findByLabelText("Resultado do teste afiliado do PRODUCT"),
    ).toHaveTextContent("meli.la");
    expect(document.body.textContent).not.toContain("https://meli.la/");
  });

  it("shows sanitized errors next to the controls", async () => {
    actions.product.mockResolvedValue({
      ok: false,
      errorCode: "PRODUCT_DIAGNOSTIC_ERROR",
      message: "Não foi possível diagnosticar este PRODUCT.",
    });
    render(<DiagnosticsPanel />);
    fireEvent.change(screen.getByLabelText("PRODUCT ID"), {
      target: { value: "MLB123" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Diagnosticar PRODUCT" }),
    );
    expect(
      await screen.findByText("Não foi possível diagnosticar este PRODUCT."),
    ).toBeInTheDocument();
    expect(screen.getByText("PRODUCT_DIAGNOSTIC_ERROR")).toBeInTheDocument();
  });
});
