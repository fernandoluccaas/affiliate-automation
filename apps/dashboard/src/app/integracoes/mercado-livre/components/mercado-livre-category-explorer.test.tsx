import React, { useEffect } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MercadoLivreCategoryBrowserDto,
  MercadoLivreCategoryDto,
  MercadoLivreCategoryTestDto,
} from "../mercado-livre-interactive-types";
import { MercadoLivreCategoryExplorer } from "./mercado-livre-category-explorer";

const actions = vi.hoisted(() => ({
  children: vi.fn(),
  test: vi.fn(),
  add: vi.fn(),
}));

vi.mock("@/lib/mercadolivre-interactive-actions", () => ({
  getMercadoLivreCategoryChildrenAction: actions.children,
  testMercadoLivreCategoryInteractiveAction: actions.test,
  addMercadoLivreCategoryInteractiveAction: actions.add,
}));

function category(
  id: string,
  name: string,
  isLeaf = false,
  path: MercadoLivreCategoryDto["path"] = [{ id, name }],
): MercadoLivreCategoryDto {
  return {
    id,
    name,
    path,
    isLeaf,
    childrenCount: isLeaf ? 0 : 1,
  };
}

const phones = category("MLB-PHONES", "Celulares");
const home = category("MLB-HOME", "Casa");
const smartphones = category("MLB-SMARTPHONES", "Smartphones", true, [
  { id: phones.id, name: phones.name },
  { id: "MLB-SMARTPHONES", name: "Smartphones" },
]);
const initialData: MercadoLivreCategoryBrowserDto = {
  currentCategory: null,
  children: [phones, home],
  configuredCategories: [],
};

function browser(
  currentCategory: MercadoLivreCategoryDto | null,
  children: MercadoLivreCategoryDto[],
): MercadoLivreCategoryBrowserDto {
  return { currentCategory, children, configuredCategories: [] };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

describe("MercadoLivreCategoryExplorer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("opens subcategories without navigation and preserves surrounding state", async () => {
    actions.children.mockResolvedValue({
      ok: true,
      data: browser(phones, [smartphones]),
      message: "Categorias atualizadas.",
    });
    const pathname = window.location.pathname;
    const documentNode = document.documentElement;
    const mounted = vi.fn();
    Object.defineProperty(window, "scrollY", {
      configurable: true,
      value: 420,
    });
    function Harness() {
      useEffect(() => mounted(), []);
      return (
        <div>
          <input aria-label="Nota externa" defaultValue="preservar" />
          <MercadoLivreCategoryExplorer initialData={initialData} />
        </div>
      );
    }
    render(<Harness />);

    fireEvent.change(screen.getByLabelText("Nota externa"), {
      target: { value: "estado local" },
    });
    fireEvent.click(
      screen.getAllByRole("button", { name: "Abrir subcategorias" })[0]!,
    );

    expect(await screen.findByText("Smartphones")).toBeInTheDocument();
    expect(screen.getByLabelText("Nota externa")).toHaveValue("estado local");
    expect(window.location.pathname).toBe(pathname);
    expect(window.scrollY).toBe(420);
    expect(document.documentElement).toBe(documentNode);
    expect(mounted).toHaveBeenCalledTimes(1);
    expect(actions.children).toHaveBeenCalledWith({ categoryId: phones.id });
  });

  it("supports breadcrumb, root and local back navigation", async () => {
    actions.children
      .mockResolvedValueOnce({
        ok: true,
        data: browser(phones, [smartphones]),
        message: "Categorias atualizadas.",
      })
      .mockResolvedValueOnce({
        ok: true,
        data: initialData,
        message: "Categorias atualizadas.",
      });
    render(<MercadoLivreCategoryExplorer initialData={initialData} />);

    fireEvent.click(
      screen.getAllByRole("button", { name: "Abrir subcategorias" })[0]!,
    );
    await screen.findByText("Smartphones");
    fireEvent.click(screen.getByRole("button", { name: "Voltar um nível" }));
    expect(screen.getAllByText("Casa").length).toBeGreaterThan(0);

    fireEvent.click(
      screen.getByRole("button", { name: "Categorias principais MLB" }),
    );
    await waitFor(() =>
      expect(actions.children).toHaveBeenLastCalledWith({ categoryId: null }),
    );
  });

  it("shows loading only on the selected row", async () => {
    const request = deferred<{
      ok: true;
      data: MercadoLivreCategoryBrowserDto;
      message: string;
    }>();
    actions.children.mockReturnValue(request.promise);
    render(<MercadoLivreCategoryExplorer initialData={initialData} />);

    const buttons = screen.getAllByRole("button", {
      name: "Abrir subcategorias",
    });
    fireEvent.click(buttons[0]!);
    expect(
      screen.getByRole("button", { name: "Abrindo subcategorias…" }),
    ).toBeDisabled();
    expect(buttons[1]).not.toBeDisabled();

    await act(async () => {
      request.resolve({
        ok: true,
        data: browser(phones, [smartphones]),
        message: "Categorias atualizadas.",
      });
    });
  });

  it("keeps the newest response when requests finish out of order", async () => {
    const first = deferred<{
      ok: true;
      data: MercadoLivreCategoryBrowserDto;
      message: string;
    }>();
    const second = deferred<{
      ok: true;
      data: MercadoLivreCategoryBrowserDto;
      message: string;
    }>();
    actions.children
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    render(<MercadoLivreCategoryExplorer initialData={initialData} />);

    const buttons = screen.getAllByRole("button", {
      name: "Abrir subcategorias",
    });
    fireEvent.click(buttons[0]!);
    fireEvent.click(buttons[1]!);
    await act(async () => {
      second.resolve({ ok: true, data: browser(home, []), message: "ok" });
    });
    expect(screen.getByText("Casa")).toBeInTheDocument();
    await act(async () => {
      first.resolve({
        ok: true,
        data: browser(phones, [smartphones]),
        message: "ok",
      });
    });
    expect(screen.queryByText("Smartphones")).not.toBeInTheDocument();
    expect(screen.getByText("Casa")).toBeInTheDocument();
  });

  it("renders an inline error without leaving the route", async () => {
    actions.children.mockResolvedValue({
      ok: false,
      errorCode: "CATEGORY_API_ERROR",
      message: "Não foi possível consultar esta categoria.",
    });
    const pathname = window.location.pathname;
    render(<MercadoLivreCategoryExplorer initialData={initialData} />);
    fireEvent.click(
      screen.getAllByRole("button", { name: "Abrir subcategorias" })[0]!,
    );

    expect(
      await screen.findByText("Não foi possível consultar esta categoria."),
    ).toBeInTheDocument();
    expect(screen.getByText("CATEGORY_API_ERROR")).toBeInTheDocument();
    expect(window.location.pathname).toBe(pathname);
  });

  it("tests a category and announces the result inline", async () => {
    const result: MercadoLivreCategoryTestDto = {
      category: smartphones,
      highlightsAvailable: true,
      candidatesFound: 3,
      highlightsReason: "OK",
      highlightItemCount: 1,
      highlightProductCount: 1,
      highlightUserProductCount: 1,
      highlightUnknownTypeCount: 0,
      resolvedItemCandidates: 3,
      unresolvedCandidates: 0,
      resolutionReasons: "",
      productDirectWinnerCount: 1,
      productParentCount: 0,
      productLeafCount: 1,
      productResolvedDirectly: 1,
      productResolvedViaChild: 0,
      productLeafWithoutWinner: 0,
      productParentWithoutResolvableChild: 0,
    };
    actions.test.mockResolvedValue({
      ok: true,
      data: result,
      message: "Teste concluído.",
    });
    render(<MercadoLivreCategoryExplorer initialData={initialData} />);
    fireEvent.change(screen.getByPlaceholderText("MLB123456"), {
      target: { value: smartphones.id },
    });
    fireEvent.click(screen.getByRole("button", { name: "Testar categoria" }));

    expect(
      await screen.findByLabelText("Resultado do teste da categoria"),
    ).toHaveTextContent("3");
    expect(actions.test).toHaveBeenCalledWith({ categoryId: smartphones.id });
    expect(screen.getByText("Teste concluído.")).toBeInTheDocument();
  });

  it("adds a leaf idempotently and updates configured categories", async () => {
    const configured = {
      ...smartphones,
      enabled: true,
      priority: 0,
      minOffers: null,
      maxOffers: null,
    };
    actions.add.mockResolvedValue({
      ok: true,
      data: {
        category: configured,
        alreadyConfigured: true,
        configuredCategories: [configured],
      },
      message: "Categoria já adicionada.",
    });
    render(
      <MercadoLivreCategoryExplorer
        initialData={browser(phones, [smartphones])}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Adicionar categoria" }),
    );

    expect(
      await screen.findByText("Categoria já adicionada."),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Categoria adicionada").length).toBeGreaterThan(
      0,
    );
    expect(actions.add).toHaveBeenCalledTimes(1);
  });
});
