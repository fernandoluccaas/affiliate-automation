import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AffiliateSessionPanel,
  type AffiliateSessionPanelInitialData,
} from "./affiliate-session-panel";

const actions = vi.hoisted(() => ({
  save: vi.fn(),
  test: vi.fn(),
  clear: vi.fn(),
  selectTag: vi.fn(),
  testLink: vi.fn(),
  pending: vi.fn(),
}));

vi.mock("@/lib/mercadolivre-interactive-actions", () => ({
  saveMercadoLivreAffiliateSessionInteractiveAction: actions.save,
  testMercadoLivreAffiliateSessionInteractiveAction: actions.test,
  clearMercadoLivreAffiliateSessionInteractiveAction: actions.clear,
  selectMercadoLivreAffiliateTagInteractiveAction: actions.selectTag,
  generateMercadoLivreAffiliateTestLinkInteractiveAction: actions.testLink,
  generatePendingMercadoLivreAffiliateLinksInteractiveAction: actions.pending,
}));

const initialData: AffiliateSessionPanelInitialData = {
  oauthConnected: true,
  configured: true,
  status: "CONNECTED",
  statusLabel: "Conectada",
  affiliateTag: "tag-1",
  tags: [{ value: "tag-1", label: "Principal", isDefault: true }],
  lastValidatedAt: "06/08/2026 18:00",
  lastCookieUpdateAt: "06/08/2026 17:00",
  oauthStatus: "CONNECTED",
  lastError: "-",
};

const sessionSuccess = {
  ok: true as const,
  data: {
    code: "TESTED",
    status: "CONNECTED",
    affiliateTag: "tag-1",
    availableTags: initialData.tags,
  },
  message: "Operação concluída.",
};

describe("AffiliateSessionPanel", () => {
  beforeEach(() => vi.clearAllMocks());

  it("saves and validates the session without navigation or exposing the cookie", async () => {
    actions.save.mockResolvedValue(sessionSuccess);
    const pathname = window.location.pathname;
    render(<AffiliateSessionPanel initialData={initialData} />);
    const cookie = screen.getByRole("textbox", {
      name: /Cookie completo do Mercado Livre/,
    });
    fireEvent.change(cookie, { target: { value: "session=private-value" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar e testar" }));

    expect(
      await screen.findByText("Sessão salva e validada."),
    ).toBeInTheDocument();
    expect(cookie).toHaveValue("");
    expect(screen.queryByText("session=private-value")).not.toBeInTheDocument();
    expect(window.location.pathname).toBe(pathname);
  });

  it("tests the connection and updates a tag inline", async () => {
    actions.test.mockResolvedValue(sessionSuccess);
    actions.selectTag.mockResolvedValue(sessionSuccess);
    render(<AffiliateSessionPanel initialData={initialData} />);

    fireEvent.click(screen.getByRole("button", { name: "Testar conexão" }));
    expect(await screen.findByText("Sessão validada.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Atualizar tag" }));
    expect(await screen.findByText("Tag atualizada.")).toBeInTheDocument();
    expect(actions.selectTag).toHaveBeenCalledWith({ affiliateTag: "tag-1" });
  });

  it("renders a generated test link next to its form", async () => {
    actions.testLink.mockResolvedValue({
      ok: true,
      data: {
        affiliateUrl: "https://meli.la/sanitized-test",
        provider: "stripe_v2",
        generatedAt: "2026-08-06T18:00:00.000Z",
      },
      message: "Link meli.la de teste gerado.",
    });
    render(<AffiliateSessionPanel initialData={initialData} />);
    fireEvent.change(
      screen.getByLabelText("URL pública do produto para teste"),
      { target: { value: "https://produto.mercadolivre.com.br/MLB-test" } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Gerar link meli.la de teste" }),
    );

    expect(
      await screen.findByRole("link", {
        name: "https://meli.la/sanitized-test",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Link meli.la de teste gerado."),
    ).toBeInTheDocument();
  });

  it("shows a sanitized pending-links summary and inline errors", async () => {
    actions.pending.mockResolvedValueOnce({
      ok: true,
      data: {
        status: "PARTIAL",
        selected: 3,
        processed: 3,
        linksGenerated: 2,
        updated: 2,
        ineligible: 0,
        pending: 1,
        failed: 1,
      },
      message: "Geração concluída parcialmente.",
    });
    render(<AffiliateSessionPanel initialData={initialData} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Gerar links pendentes" }),
    );
    expect(await screen.findByText(/2 links gerados/)).toBeInTheDocument();

    actions.pending.mockResolvedValueOnce({
      ok: false,
      errorCode: "AFFILIATE_LINK_BATCH_FAILED",
      message: "Não foi possível gerar os links pendentes.",
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Gerar links pendentes" }),
    );
    expect(
      await screen.findByText("Não foi possível gerar os links pendentes."),
    ).toBeInTheDocument();
  });
});
