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
const bulkAction = vi.hoisted(() => vi.fn());
const remoteFeedsAction = vi.hoisted(() => vi.fn());
const remotePreviewAction = vi.hoisted(() => vi.fn());
const remoteImportAction = vi.hoisted(() => vi.fn());

vi.mock("@/lib/shopee-datafeed-actions", () => ({
  inspectShopeeDatafeedAction: inspectAction,
  previewShopeeDatafeedAction: previewAction,
  confirmShopeeDatafeedImportAction: importAction,
  retryShopeeAffiliateLinkAction: retryAction,
  applyManualShopeeAffiliateLinkAction: manualAction,
  generatePendingShopeeAffiliateLinksAction: bulkAction,
  listShopeeOfficialFeedsAction: remoteFeedsAction,
  previewShopeeRemoteDiscoveryAction: remotePreviewAction,
  confirmShopeeRemoteImportAction: remoteImportAction,
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
  recentSelectionWindowDays: 7,
  maxPerShopPerSession: 2,
  autoLinkAfterImport: false,
  autoLinkMaxPerRun: 12,
  autoLinkConcurrency: 1,
  discoverySource: "LOCAL_FILE",
  automatedDiscoveryEnabled: false,
  automatedDiscoveryIntervalHours: 24,
  automatedDiscoveryIntervalMs: 86_400_000,
  remoteDiscoveryContract: "OFFICIAL_V2_FULL",
  remoteDiscoveryState: "DISABLED_BY_SOURCE",
  remoteDiscoveryReady: false,
  remoteDiscoveryLockConfigured: false,
  remoteDiscoveryAutoRunReady: false,
  remoteDiscoveryPageSize: 500,
  remoteDiscoveryMaxPages: 10,
  remoteDiscoveryMaxItems: 10_000,
  remoteDiscoveryFeedIds: [],
  remoteDiscoveryReferenceIds: [],
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
      offerState: { offerCounts: { pending: 0, ready: 0 }, pendingOffers: [] },
    });
    retryAction.mockResolvedValue({
      ok: true,
      message: "Link gerado.",
      offerState: { offerCounts: { pending: 0, ready: 1 }, pendingOffers: [] },
    });
    manualAction.mockResolvedValue({
      ok: true,
      message: "Link aplicado.",
      offerState: { offerCounts: { pending: 0, ready: 1 }, pendingOffers: [] },
    });
    bulkAction.mockResolvedValue({
      ok: true,
      message: "2 links aplicados; nenhuma Publication criada.",
      data: {
        status: "SUCCEEDED",
        linked: 2,
        remainingPending: 0,
        items: [],
      },
      offerState: { offerCounts: { pending: 0, ready: 2 }, pendingOffers: [] },
    });
    remoteFeedsAction.mockResolvedValue({
      ok: true,
      message: "1 feed(s) FULL localizado(s).",
      data: {
        status: "SUCCEEDED",
        feeds: [
          {
            datafeedId: "ref-safe_FULL_2026-08-19",
            referenceId: "ref-safe",
            name: "Feed sanitizado",
            totalCount: 10_000,
            date: "20260819",
            feedMode: "FULL",
          },
        ],
        externalRequests: 1,
        writes: 0,
        stateModified: false,
      },
    });
    remotePreviewAction.mockResolvedValue({
      ok: true,
      message: "Preview remoto concluído.",
      data: {
        status: "PREVIEW_COMPLETED",
        source: "OPEN_API_FEED",
        complete: true,
        feed: null,
        feeds: [],
        feedsDiscovered: 1,
        feedsSelected: 1,
        feedsProcessed: 1,
        currentFeed: "ref-safe",
        feedTotalCount: 10_000,
        pagesFetched: 20,
        itemsReceived: 10_000,
        itemsNormalized: 9_990,
        itemsRejected: 10,
        duplicates: 2,
        eligible: 12,
        candidatePoolSize: 12,
        eligibleByCategory: {},
        selected: [],
        apiRequests: 21,
        durationMs: 10,
        errorCode: null,
        databaseWrites: 0,
        publicationsCreated: 0,
        messagesSent: 0,
        stateModified: false,
      },
    });
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

  it("shows the official contract without issuing an automatic request", () => {
    render(<ShopeeDatafeedConsole configuration={configuration} />);
    fireEvent.click(screen.getByRole("tab", { name: "Datafeeds" }));
    expect(
      screen.getByText("Feed remoto desativado pela configuração"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Consultar feeds oficiais" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Executar preview pela Open API" }),
    ).toBeDisabled();
    expect(inspectAction).not.toHaveBeenCalled();
    expect(previewAction).not.toHaveBeenCalled();
    expect(remoteFeedsAction).not.toHaveBeenCalled();
  });

  it("lists and previews official feeds only after explicit clicks", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(
      <ShopeeDatafeedConsole
        configuration={{
          ...configuration,
          mode: "HYBRID",
          state: "READY_FOR_HYBRID",
          discoverySource: "OPEN_API_FEED",
          openApiConfigured: true,
          openApiReady: true,
          externalRequestsEnabled: true,
          remoteDiscoveryReady: true,
          remoteDiscoveryState: "READY_FOR_OPEN_API_FEED",
        }}
      />,
    );
    expect(remoteFeedsAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("tab", { name: "Datafeeds" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Consultar feeds oficiais" }),
    );
    const feedOption = await screen.findByRole("checkbox", {
      name: /Feed sanitizado/,
    });
    fireEvent.click(feedOption);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Executar preview pela Open API",
      }),
    );
    expect(
      await screen.findByText(/9990 normalizados, 10 rejeitados/),
    ).toBeInTheDocument();
    expect(remotePreviewAction).toHaveBeenCalledWith(
      expect.objectContaining({
        confirmLiveCall: true,
        referenceIds: ["ref-safe"],
        pageSize: 500,
      }),
    );
    confirm.mockRestore();
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

  it("updates the pending-offer island after import without navigation", async () => {
    const pathname = window.location.pathname;
    Object.defineProperty(window, "scrollY", {
      configurable: true,
      value: 360,
    });
    importAction.mockResolvedValueOnce({
      ok: true,
      message: "Importação concluída.",
      data: {
        status: "SUCCEEDED_WITH_ERRORS",
        preview: previewSuccess().data,
        importJobId: "job-safe",
        metrics: {
          selected: 1,
          created: 1,
          updated: 0,
          linksGenerated: 0,
          linksReused: 0,
          readyToPublish: 0,
          pendingAffiliateLink: 1,
          failed: 0,
        },
        stateModified: true,
        publicationsCreated: 0,
        messagesSent: 0,
      },
      offerState: {
        offerCounts: { pending: 1, ready: 0 },
        pendingOffers: [
          {
            id: "offer-new",
            title: "Produto recém-importado",
            externalProductId: "100002",
            statusReason: "AFFILIATE_LINK_REQUIRED",
          },
        ],
      },
    });
    render(<ShopeeDatafeedConsole configuration={configuration} />);
    setFile();
    fireEvent.click(screen.getByRole("tab", { name: "Descoberta" }));
    fireEvent.click(screen.getByRole("button", { name: "Executar preview" }));
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Confirmar importação dos vencedores",
      }),
    );

    expect(
      await screen.findByText("Produto recém-importado"),
    ).toBeInTheDocument();
    expect(window.location.pathname).toBe(pathname);
    expect(window.scrollY).toBe(360);
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

  it("shows the pending counter and requires visual confirmation for bulk", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(
      <ShopeeDatafeedConsole
        configuration={{
          ...configuration,
          mode: "HYBRID",
          state: "READY_FOR_HYBRID",
          openApiConfigured: true,
          openApiReady: true,
          externalRequestsEnabled: true,
          offerCounts: { pending: 2, ready: 0 },
          pendingOffers: [
            {
              id: "offer-1",
              title: "Produto 1",
              externalProductId: "1001",
              statusReason: "AFFILIATE_LINK_REQUIRED",
            },
          ],
        }}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Links" }));
    const button = screen.getByRole("button", {
      name: /Gerar links das 2 pendentes/,
    });
    fireEvent.click(button);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("2 ofertas"));
    expect(bulkAction).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it("renders partial bulk success and updates only the local Links island", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const pathname = window.location.pathname;
    Object.defineProperty(window, "scrollY", {
      configurable: true,
      value: 275,
    });
    bulkAction.mockResolvedValueOnce({
      ok: true,
      message: "1 links aplicados; 1 ofertas ainda precisam de atenção.",
      data: {
        status: "SUCCEEDED_WITH_ERRORS",
        linked: 1,
        remainingPending: 1,
        items: [
          {
            offerId: "offer-2",
            itemId: "1002",
            status: "FAILED",
            attempts: 1,
            errorCode: "SHOPEE_ORIGIN_URL_INVALID",
          },
        ],
      },
      offerState: {
        offerCounts: { pending: 1, ready: 1 },
        pendingOffers: [
          {
            id: "offer-2",
            title: "Produto 2",
            externalProductId: "1002",
            statusReason: "AFFILIATE_LINK_REQUIRED",
          },
        ],
      },
    });
    render(
      <ShopeeDatafeedConsole
        configuration={{
          ...configuration,
          mode: "HYBRID",
          state: "READY_FOR_HYBRID",
          openApiConfigured: true,
          openApiReady: true,
          externalRequestsEnabled: true,
          offerCounts: { pending: 2, ready: 0 },
          pendingOffers: [
            {
              id: "offer-1",
              title: "Produto 1",
              externalProductId: "1001",
              statusReason: "AFFILIATE_LINK_REQUIRED",
            },
            {
              id: "offer-2",
              title: "Produto 2",
              externalProductId: "1002",
              statusReason: "AFFILIATE_LINK_REQUIRED",
            },
          ],
        }}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Links" }));
    fireEvent.click(
      screen.getByRole("button", { name: /Gerar links das 2 pendentes/ }),
    );
    expect(
      await screen.findByText("Geração concluída com pendências"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/1 links gerados; 1 ofertas pendentes/),
    ).toBeInTheDocument();
    expect(screen.getByText(/SHOPEE_ORIGIN_URL_INVALID/)).toBeInTheDocument();
    expect(screen.queryByText("Produto 1")).not.toBeInTheDocument();
    expect(screen.getByText("Produto 2")).toBeInTheDocument();
    expect(window.location.pathname).toBe(pathname);
    expect(window.scrollY).toBe(275);
    expect(screen.getByRole("tab", { name: "Links" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(bulkAction).toHaveBeenCalledWith({
      confirmGenerate: true,
      maxItems: 2,
    });
    confirm.mockRestore();
  });

  it("prevents a duplicate bulk click while generation is pending", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    let resolve!: (value: unknown) => void;
    bulkAction.mockReturnValue(new Promise((done) => (resolve = done)));
    render(
      <ShopeeDatafeedConsole
        configuration={{
          ...configuration,
          mode: "HYBRID",
          state: "READY_FOR_HYBRID",
          openApiConfigured: true,
          openApiReady: true,
          offerCounts: { pending: 1, ready: 0 },
          pendingOffers: [
            {
              id: "offer-1",
              title: "Produto 1",
              externalProductId: "1001",
              statusReason: null,
            },
          ],
        }}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Links" }));
    const button = screen.getByRole("button", {
      name: /Gerar links das 1 pendentes/,
    });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(bulkAction).toHaveBeenCalledOnce();
    resolve({
      ok: true,
      message: "Concluído.",
      data: { status: "SUCCEEDED", linked: 1, remainingPending: 0, items: [] },
      offerState: { offerCounts: { pending: 0, ready: 1 }, pendingOffers: [] },
    });
    await waitFor(() =>
      expect(screen.getByText("Concluído.")).toBeInTheDocument(),
    );
    confirm.mockRestore();
  });

  it("shows a global bulk failure without removing the pending offer", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    bulkAction.mockResolvedValueOnce({
      ok: true,
      message: "A geração foi interrompida; 1 ofertas continuam pendentes.",
      data: {
        status: "FAILED",
        linked: 0,
        remainingPending: 1,
        items: [
          {
            offerId: "offer-1",
            itemId: "1001",
            status: "NOT_ATTEMPTED",
            attempts: 0,
            errorCode: "SHOPEE_BULK_LINK_GLOBAL_FAILURE",
          },
        ],
      },
      offerState: {
        offerCounts: { pending: 1, ready: 0 },
        pendingOffers: [
          {
            id: "offer-1",
            title: "Produto 1",
            externalProductId: "1001",
            statusReason: null,
          },
        ],
      },
    });
    render(
      <ShopeeDatafeedConsole
        configuration={{
          ...configuration,
          mode: "HYBRID",
          state: "READY_FOR_HYBRID",
          openApiConfigured: true,
          openApiReady: true,
          offerCounts: { pending: 1, ready: 0 },
          pendingOffers: [
            {
              id: "offer-1",
              title: "Produto 1",
              externalProductId: "1001",
              statusReason: null,
            },
          ],
        }}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Links" }));
    fireEvent.click(
      screen.getByRole("button", { name: /Gerar links das 1 pendentes/ }),
    );
    expect(await screen.findByText("Geração interrompida")).toBeInTheDocument();
    expect(screen.getByText("Produto 1")).toBeInTheDocument();
    expect(
      screen.getByText(/SHOPEE_BULK_LINK_GLOBAL_FAILURE/),
    ).toBeInTheDocument();
    confirm.mockRestore();
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
    expect(screen.queryByText("Produto de teste")).not.toBeInTheDocument();
    expect(
      screen.getByText(/1 oferta\(s\) pronta\(s\) e 0 aguardando link/),
    ).toBeInTheDocument();
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
