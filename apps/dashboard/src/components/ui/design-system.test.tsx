import React, { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
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
