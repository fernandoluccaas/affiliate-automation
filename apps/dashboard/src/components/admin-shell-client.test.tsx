import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { AdminShellClient } from "@/components/admin-shell-client";
import { ThemeToggle } from "@/components/theme-toggle";

describe("AdminShell", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });

  it("renders grouped desktop navigation, breadcrumbs and active item", () => {
    render(
      <AdminShellClient
        currentPath="/ofertas/affiliate-links"
        title="Links de afiliado"
        userEmail="admin@example.test"
        logout={<button>Sair</button>}
      >
        <p>Conteúdo</p>
      </AdminShellClient>,
    );
    expect(
      screen.getAllByRole("navigation", { name: "Navegação principal" })[0],
    ).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Ofertas" })[0]).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(
      screen.getByRole("navigation", { name: "Breadcrumb" }),
    ).toHaveTextContent("Links de afiliado");
    expect(
      screen.getByRole("link", { name: "Ir para o conteúdo" }),
    ).toHaveAttribute("href", "#main-content");
  });

  it("opens mobile navigation, closes with Escape and returns focus", () => {
    render(
      <AdminShellClient
        currentPath="/"
        title="Dashboard"
        userEmail="admin@example.test"
        logout={<button>Sair</button>}
      >
        <p>Conteúdo</p>
      </AdminShellClient>,
    );
    const trigger = screen.getByRole("button", {
      name: "Abrir menu principal",
    });
    fireEvent.click(trigger);
    expect(
      screen.getByRole("dialog", { name: "Menu principal" }),
    ).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(
      screen.queryByRole("dialog", { name: "Menu principal" }),
    ).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("persists the collapsed sidebar preference", () => {
    render(
      <AdminShellClient
        currentPath="/"
        title="Dashboard"
        userEmail="admin@example.test"
        logout={<button>Sair</button>}
      >
        <p>Conteúdo</p>
      </AdminShellClient>,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Recolher barra lateral" }),
    );
    expect(localStorage.getItem("affiliate-sidebar-collapsed")).toBe("true");
    expect(
      screen.getByRole("button", { name: "Expandir barra lateral" }),
    ).toBeInTheDocument();
  });

  it("cycles and persists theme preference", () => {
    render(<ThemeToggle />);
    fireEvent.click(
      screen.getByRole("button", { name: /Seguir o sistema.*Alterar tema/ }),
    );
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem("affiliate-theme")).toBe("light");
  });
});
