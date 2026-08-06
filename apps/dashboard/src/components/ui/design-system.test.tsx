import React, { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { StatusBadge } from "@/components/ui/status-badge";
import { DataTableContainer } from "@/components/ui/table";
import { PageTabs } from "@/components/ui/tabs";
import { EmptyState } from "@/components/empty-state";

describe("dashboard design system", () => {
  it("renders a native button", () => {
    render(<Button variant="outline">Revisar</Button>);
    const button = screen.getByRole("button", { name: "Revisar" });
    expect(button.tagName).toBe("BUTTON");
    expect(button).toHaveClass("border");
  });

  it("disables a loading native button and exposes its busy state", () => {
    render(<Button loading>Salvar</Button>);
    const button = screen.getByRole("button", { name: "Salvar" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button.querySelector("svg")).toBeInTheDocument();
  });

  it("uses loadingLabel as the native button accessible name", () => {
    render(
      <Button loading loadingLabel="Salvando">
        Salvar
      </Button>,
    );
    expect(screen.getByRole("button", { name: "Salvando" })).toBeDisabled();
    expect(screen.queryByText("Salvar")).not.toBeInTheDocument();
  });

  it("renders an asChild Link as the interactive element without nesting a button", () => {
    expect(() =>
      render(
        <Button asChild variant="outline" className="dashboard-action">
          <Link href="/ofertas">Revisar ofertas</Link>
        </Button>,
      ),
    ).not.toThrow();

    const link = screen.getByRole("link", { name: "Revisar ofertas" });
    expect(link).toHaveAttribute("href", "/ofertas");
    expect(link).toHaveClass("dashboard-action", "border");
    expect(link.tagName).toBe("A");
    expect(link.closest("button")).toBeNull();
  });

  it("supports an icon inside the asChild Link", () => {
    const ref = React.createRef<HTMLElement>();
    render(
      <Button asChild ref={ref}>
        <Link href="/ofertas/nova">
          Nova oferta
          <ArrowRight aria-hidden="true" />
        </Link>
      </Button>,
    );
    const link = screen.getByRole("link", { name: "Nova oferta" });
    expect(link).toHaveAttribute("href", "/ofertas/nova");
    expect(link.querySelector("svg")).toBeInTheDocument();
    expect(ref.current).toBe(link);
  });

  it("keeps asChild loading structurally valid and blocks activation", () => {
    const onClick = vi.fn();
    render(
      <Button asChild loading loadingLabel="Abrindo" onClick={onClick}>
        <Link href="/ofertas">Revisar ofertas</Link>
      </Button>,
    );
    const link = screen.getByRole("link", { name: "Revisar ofertas" });
    expect(link).toHaveAttribute("aria-busy", "true");
    expect(link).toHaveAttribute("aria-disabled", "true");
    expect(link).not.toHaveTextContent("Abrindo");

    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    expect(link.dispatchEvent(click)).toBe(false);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("exposes semantic button loading and alert feedback", () => {
    render(
      <>
        <Button loading loadingLabel="Salvando…">
          Salvar
        </Button>
        <Alert tone="danger">Não foi possível salvar.</Alert>
      </>,
    );
    expect(screen.getByRole("button", { name: "Salvando…" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Não foi possível salvar.",
    );
  });

  it("translates status without relying only on color", () => {
    render(<StatusBadge status="READY_FOR_AFFILIATE_LINK" />);
    expect(screen.getByText("Aguardando link")).toBeInTheDocument();
  });

  it("labels fields, tabs, tables and empty states", () => {
    render(
      <>
        <FormField
          label="Nome"
          htmlFor="name"
          description="Identificação visível"
        >
          <input id="name" />
        </FormField>
        <PageTabs
          items={[{ label: "Visão geral", href: "#overview", active: true }]}
        />
        <DataTableContainer label="Ofertas">
          <table>
            <thead>
              <tr>
                <th>Título</th>
              </tr>
            </thead>
          </table>
        </DataTableContainer>
        <EmptyState
          title="Nenhum item"
          description="Adicione o primeiro item para começar."
        />
      </>,
    );
    expect(screen.getByRole("tab", { name: "Visão geral" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("region", { name: "Ofertas" })).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Nenhum item" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Identificação visível")).toBeInTheDocument();
    expect(screen.getByLabelText("Nome")).toBeInTheDocument();
  });

  it("closes dialogs with Escape and restores focus", () => {
    const onClose = vi.fn();
    function Fixture() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Abrir detalhes</button>
          <Dialog
            open={open}
            title="Detalhes"
            onClose={() => {
              onClose();
              setOpen(false);
            }}
          >
            <button>Confirmar</button>
          </Dialog>
        </>
      );
    }
    render(<Fixture />);
    const trigger = screen.getByRole("button", { name: "Abrir detalhes" });
    trigger.focus();
    fireEvent.click(trigger);
    expect(
      screen.getByRole("dialog", { name: "Detalhes" }),
    ).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    expect(trigger).toHaveFocus();
  });
});
