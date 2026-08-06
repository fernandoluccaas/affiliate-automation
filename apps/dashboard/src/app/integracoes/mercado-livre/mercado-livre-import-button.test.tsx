import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MercadoLivreImportButton } from "./mercado-livre-import-button";

const sync = vi.hoisted(() => vi.fn());
vi.mock("@/lib/mercadolivre-interactive-actions", () => ({
  syncMercadoLivreNowInteractiveAction: sync,
}));

const summary = {
  status: "SUCCEEDED" as const,
  candidatesFound: 20,
  resolvedItemCandidates: 19,
  newProducts: 17,
  newOfferVersions: 17,
  updatedOffers: 2,
  readyToPublish: 0,
  readyForAffiliateLink: 19,
  affiliateLinksGenerated: 0,
  affiliateLinksReused: 0,
  errors: 0,
};

describe("MercadoLivreImportButton", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the sanitized import result inline without navigation", async () => {
    sync.mockResolvedValue({
      ok: true,
      data: summary,
      message: "Importação concluída.",
    });
    const pathname = window.location.pathname;
    render(<MercadoLivreImportButton disabled={false} />);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Importar mais vendidos e gerar links",
      }),
    );
    expect(await screen.findByText(/20 encontrados/)).toBeInTheDocument();
    expect(screen.getByText("Importação concluída.")).toBeInTheDocument();
    expect(window.location.pathname).toBe(pathname);
  });

  it("blocks duplicate execution while pending", async () => {
    let resolve!: (value: unknown) => void;
    sync.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    render(<MercadoLivreImportButton disabled={false} />);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Importar mais vendidos e gerar links",
      }),
    );
    const pending = screen.getByRole("button", {
      name: "Importando, resolvendo e gerando links…",
    });
    fireEvent.click(pending);
    expect(sync).toHaveBeenCalledTimes(1);
    await act(async () =>
      resolve({ ok: true, data: summary, message: "Importação concluída." }),
    );
  });

  it("renders sanitized failures next to the trigger", async () => {
    sync.mockResolvedValue({
      ok: false,
      errorCode: "DISCOVERY_FAILED",
      message: "Não foi possível concluir a importação.",
    });
    render(<MercadoLivreImportButton disabled={false} />);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Importar mais vendidos e gerar links",
      }),
    );
    expect(
      await screen.findByText("Não foi possível concluir a importação."),
    ).toBeInTheDocument();
  });
});
