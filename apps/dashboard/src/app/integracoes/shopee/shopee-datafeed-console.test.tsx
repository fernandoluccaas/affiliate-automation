import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ShopeeDashboardConfigurationDto } from "./shopee-types";
import { ShopeeDatafeedConsole } from "./shopee-datafeed-console";

const inspectAction = vi.hoisted(() => vi.fn());
const previewAction = vi.hoisted(() => vi.fn());
const importAction = vi.hoisted(() => vi.fn());
const retryAction = vi.hoisted(() => vi.fn());
const manualAction = vi.hoisted(() => vi.fn());

vi.mock("@/lib/shopee-datafeed-actions", () => ({
  inspectShopeeDatafeedAction: inspectAction,
  previewShopeeDatafeedAction: previewAction,
  confirmShopeeDatafeedImportAction: importAction,
  retryShopeeAffiliateLinkAction: retryAction,
  applyManualShopeeAffiliateLinkAction: manualAction,
}));

const categories: ShopeeDashboardConfigurationDto["categories"] = [
  ["CELULARES", "Celulares", "Mobile & Gadgets", "Mobile Phones"],
  ["CASA", "Casa", "Home & Living"],
  ["MODA", "Moda", "Women Clothes"],
  ["RELOGIOS", "Relógios", "Watches"],
  ["AUTOMOTIVO", "Automotivo", "Spare Parts and Accessories for Vehicles"],
  ["ELETRODOMESTICOS", "Eletrodomésticos", "Home Appliances"],
].map(([id, label, category1, category2], index) => ({
  id: id as ShopeeDashboardConfigurationDto["categories"][number]["id"],
  label: label!,
  enabled: true,
  priority: 60 - index * 10,
  minPerCategory: 1,
  maxPerCategory: 2,
  matches: [{ category1: category1!, ...(category2 ? { category2 } : {}) }],
}));

const configuration: ShopeeDashboardConfigurationDto = {
  enabled: true,
  requestedMode: "DATAFEED",
  mode: "DATAFEED",
  state: "READY_FOR_DATAFEED",
  configurationValid: true,
  linksVerified: false,
  openApiConfigured: false,
  openApiReady: false,
  externalRequestsEnabled: false,
  operationalWritesEnabled: true,
  openApiTimeoutMs: 10_000,
  openApiRateLimitPerHour: 1_000,
  maxFileBytes: 536_870_912,
  maxTrackedItems: 2_000_000,
  issues: [],
  offerCounts: { pending: 0, ready: 0 },
  pendingOffers: [],
  categories,
};

function inspectSuccess() {
  return {
    ok: true as const,
    message: "Inspecionado.",
    data: {
      status: "INSPECTED" as const,
      files: [],
      rowsProcessed: 10,
      validRows: 8,
      invalidRows: 2,
      duplicateItems: 1,
      categories: { "Home & Living": 3 },
      validProductUrls: 8,
      candidateShortLinks: 8,
      issuesByCode: { INVALID_ITEM_ID: 2 },
      issueSamples: [],
      durationMs: 10,
      stateModified: false as const,
    },
  };
}

function previewSuccess() {
  return {
    ok: true as const,
    message: "Preview concluído.",
    data: {
      status: "PREVIEW_COMPLETED" as const,
      files: [],
      rowsProcessed: 10,
      validRows: 8,
      invalidRows: 2,
      duplicateItems: 1,
      mergeConflicts: 0,
      conflictsByCode: {},
      rejectedByCode: {},
      categories: [],
      selected: [],
      linksVerified: false,
      publicationAllowed: false as const,
      databaseWrites: 0 as const,
      publicationsCreated: 0 as const,
      messagesSent: 0 as const,
      durationMs: 10,
      stateModified: false as const,
    },
  };
}

function setFile() {
  fireEvent.click(screen.getByRole("tab", { name: "Datafeeds" }));
  fireEvent.change(screen.getByLabelText("Arquivo 1"), {
    target: { value: "C:\\feeds\\shopee.csv" },
  });
}

describe("ShopeeDatafeedConsole", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    inspectAction.mockResolvedValue(inspectSuccess());
    previewAction.mockResolvedValue(previewSuccess());
    importAction.mockResolvedValue({
      ok: true,
      message: "Importação concluída.",
      data: {
        status: "SUCCEEDED",
        preview: previewSuccess().data,
        importJobId: "job-safe",
        metrics: {
          selected: 0,
          created: 0,
          updated: 0,
          linksGenerated: 0,
          linksReused: 0,
          readyToPublish: 0,
          pendingAffiliateLink: 0,
          failed: 0,
        },
        stateModified: true,
        publicationsCreated: 0,
        messagesSent: 0,
      },
    });
    retryAction.mockResolvedValue({ ok: true, message: "Link gerado." });
    manualAction.mockResolvedValue({ ok: true, message: "Link aplicado." });
  });

  it("switches tabs without navigation or losing local form state", () => {
    const pathname = window.location.pathname;
    Object.defineProperty(window, "scrollY", {
      configurable: true,
      value: 420,
    });
    render(<ShopeeDatafeedConsole configuration={configuration} />);
    setFile();
    fireEvent.click(screen.getByRole("tab", { name: "Categorias" }));
    fireEvent.click(screen.getByRole("tab", { name: "Datafeeds" }));
    expect(screen.getByLabelText("Arquivo 1")).toHaveValue(
      "C:\\feeds\\shopee.csv",
    );
    expect(window.location.pathname).toBe(pathname);
    expect(window.scrollY).toBe(420);
  });

  it("shows inspect feedback inline", async () => {
    render(<ShopeeDatafeedConsole configuration={configuration} />);
    setFile();
    fireEvent.click(screen.getByRole("button", { name: "Inspecionar feed" }));
    expect(
      await screen.findByText(/10 processadas, 8 válidas/),
    ).toBeInTheDocument();
    expect(inspectAction).toHaveBeenCalledOnce();
  });

  it("shows preview feedback with zero operational effects", async () => {
    render(<ShopeeDatafeedConsole configuration={configuration} />);
    setFile();
    fireEvent.click(screen.getByRole("tab", { name: "Descoberta" }));
    fireEvent.click(screen.getByRole("button", { name: "Executar preview" }));
    expect(
      await screen.findByText(/0 escritas, 0 Publications e 0 mensagens/),
    ).toBeInTheDocument();
    expect(previewAction).toHaveBeenCalledOnce();
  });

  it("preserves category edits across tabs", () => {
    render(<ShopeeDatafeedConsole configuration={configuration} />);
    fireEvent.click(screen.getByRole("tab", { name: "Categorias" }));
    fireEvent.click(screen.getByRole("switch", { name: /Celulares/ }));
    fireEvent.click(screen.getByRole("tab", { name: "Links" }));
    fireEvent.click(screen.getByRole("tab", { name: "Categorias" }));
    expect(screen.getByRole("switch", { name: /Celulares/ })).not.toBeChecked();
  });

  it("displays the fail-closed Open API state", () => {
    render(<ShopeeDatafeedConsole configuration={configuration} />);
    fireEvent.click(screen.getByRole("tab", { name: "Links" }));
    expect(screen.getByText("Geração de links")).toBeInTheDocument();
    expect(screen.getByText(/Open API não configurada/)).toBeInTheDocument();
    expect(screen.getByText("Nenhuma oferta pendente")).toBeInTheDocument();
  });

  it("requires preview before explicit import confirmation", async () => {
    render(<ShopeeDatafeedConsole configuration={configuration} />);
    setFile();
    fireEvent.click(screen.getByRole("tab", { name: "Descoberta" }));
    fireEvent.click(screen.getByRole("button", { name: "Executar preview" }));
    const confirm = await screen.findByRole("button", {
      name: "Confirmar importação dos vencedores",
    });
    expect(importAction).not.toHaveBeenCalled();
    fireEvent.click(confirm);
    expect(
      await screen.findByText(/nenhuma Publication criada/),
    ).toBeInTheDocument();
    expect(importAction).toHaveBeenCalledOnce();
  });

  it("offers controlled Open API retry for pending offers", async () => {
    render(
      <ShopeeDatafeedConsole
        configuration={{
          ...configuration,
          openApiConfigured: true,
          openApiReady: true,
          externalRequestsEnabled: true,
          offerCounts: { pending: 1, ready: 0 },
          pendingOffers: [
            {
              id: "offer-safe",
              title: "Produto de teste",
              externalProductId: "100001",
              statusReason: "AFFILIATE_LINK_REQUIRED",
            },
          ],
        }}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Links" }));
    fireEvent.click(screen.getByRole("button", { name: /Tentar Open API/ }));
    expect(await screen.findByText("Link gerado.")).toBeInTheDocument();
    expect(retryAction).toHaveBeenCalledWith("offer-safe");
  });

  it("keeps the manual affiliate-link fallback explicit", async () => {
    render(
      <ShopeeDatafeedConsole
        configuration={{
          ...configuration,
          offerCounts: { pending: 1, ready: 0 },
          pendingOffers: [
            {
              id: "offer-safe",
              title: "Produto de teste",
              externalProductId: "100001",
              statusReason: "AFFILIATE_LINK_REQUIRED",
            },
          ],
        }}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Links" }));
    fireEvent.change(
      screen.getByLabelText("Link manual para Produto de teste"),
      {
        target: { value: "https://s.shopee.com.br/fixture" },
      },
    );
    fireEvent.click(
      screen.getByRole("button", { name: /Aplicar link manual/ }),
    );
    expect(await screen.findByText("Link aplicado.")).toBeInTheDocument();
    expect(manualAction).toHaveBeenCalledWith({
      offerId: "offer-safe",
      affiliateUrl: "https://s.shopee.com.br/fixture",
    });
  });

  it("prevents a duplicate click while inspect is pending", async () => {
    let resolve!: (value: ReturnType<typeof inspectSuccess>) => void;
    inspectAction.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    render(<ShopeeDatafeedConsole configuration={configuration} />);
    setFile();
    const button = screen.getByRole("button", { name: "Inspecionar feed" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(inspectAction).toHaveBeenCalledOnce();
    resolve(inspectSuccess());
    await waitFor(() =>
      expect(screen.getByText(/10 processadas/)).toBeInTheDocument(),
    );
  });
});
