import React from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MercadoLivreConfiguredCategoryDto,
  MercadoLivreDiscoveryConfigDto,
} from "../mercado-livre-interactive-types";
import { DiscoverySettingsForm } from "./discovery-settings-form";

const saveAction = vi.hoisted(() => vi.fn());

vi.mock("@/lib/mercadolivre-interactive-actions", () => ({
  saveMercadoLivreConfigInteractiveAction: saveAction,
}));

const initialConfig: MercadoLivreDiscoveryConfigDto = {
  enabled: true,
  siteId: "MLB",
  bestSellersEnabled: true,
  minimumPrice: "10",
  maximumPrice: "1000",
  minimumDiscountPercentage: "5",
  minimumScore: 50,
  maxCandidatesPerCategory: 20,
  refreshIntervalMinutes: 360,
  multiCategoryEnabled: true,
  multiCategoryMinOffersPerCategory: 1,
  multiCategoryMaxOffersPerCategory: 2,
  multiCategoryMaxTotalPerSession: 12,
  multiCategorySelectionMode: "ROUND_ROBIN",
  multiCategoryAllowCategoryBackfill: false,
  categories: [],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

describe("DiscoverySettingsForm", () => {
  beforeEach(() => vi.clearAllMocks());

  it("saves through the typed action without navigation and preserves values", async () => {
    saveAction.mockResolvedValue({
      ok: true,
      data: { ...initialConfig, minimumScore: 75 },
      message: "Configuração salva.",
    });
    const pathname = window.location.pathname;
    render(<DiscoverySettingsForm initialConfig={initialConfig} />);

    fireEvent.change(screen.getByLabelText("Score mínimo"), {
      target: { value: "75" },
    });
    expect(screen.getByText("Alterações não salvas")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Salvar configuração" }),
    );

    expect(await screen.findByText("Configuração salva.")).toBeInTheDocument();
    expect(screen.getByLabelText("Score mínimo")).toHaveValue(75);
    expect(screen.getByText("Configuração sincronizada")).toBeInTheDocument();
    expect(window.location.pathname).toBe(pathname);
    expect(saveAction).toHaveBeenCalledTimes(1);
    expect(saveAction.mock.calls[0]?.[0]).toBeInstanceOf(FormData);
  });

  it("blocks duplicate submits while the save is pending", async () => {
    const request = deferred<{
      ok: true;
      data: MercadoLivreDiscoveryConfigDto;
      message: string;
    }>();
    saveAction.mockReturnValue(request.promise);
    render(<DiscoverySettingsForm initialConfig={initialConfig} />);

    fireEvent.click(
      screen.getByRole("button", { name: "Salvar configuração" }),
    );
    const pendingButton = screen.getByRole("button", {
      name: "Salvando configuração…",
    });
    expect(pendingButton).toBeDisabled();
    fireEvent.click(pendingButton);
    expect(saveAction).toHaveBeenCalledTimes(1);

    await act(async () => {
      request.resolve({
        ok: true,
        data: initialConfig,
        message: "Configuração salva.",
      });
    });
  });

  it("shows field-safe errors inline", async () => {
    saveAction.mockResolvedValue({
      ok: false,
      errorCode: "CONFIG_INVALID",
      message: "Revise os campos destacados da configuração.",
      fieldErrors: { minimumScore: "Valor inválido" },
    });
    render(<DiscoverySettingsForm initialConfig={initialConfig} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Salvar configuração" }),
    );

    expect(
      await screen.findByText("Revise os campos destacados da configuração."),
    ).toBeInTheDocument();
    expect(screen.getByText("CONFIG_INVALID")).toBeInTheDocument();
  });

  it("receives a newly added category without remounting the form", async () => {
    render(<DiscoverySettingsForm initialConfig={initialConfig} />);
    fireEvent.change(screen.getByLabelText("Score mínimo"), {
      target: { value: "61" },
    });
    const added: MercadoLivreConfiguredCategoryDto = {
      id: "MLB-LEAF",
      name: "Celulares",
      path: [{ id: "MLB-LEAF", name: "Celulares" }],
      childrenCount: 0,
      isLeaf: true,
      enabled: true,
      priority: 0,
      minOffers: null,
      maxOffers: null,
    };

    act(() => {
      window.dispatchEvent(
        new CustomEvent("mercadolivre:category-added", { detail: added }),
      );
    });

    await waitFor(() =>
      expect(screen.getByText("Celulares")).toBeInTheDocument(),
    );
    expect(screen.getByLabelText("Score mínimo")).toHaveValue(61);
    expect(
      screen.getByRole("textbox", { name: "IDs de categorias" }),
    ).toHaveValue("MLB-LEAF");
  });
});
