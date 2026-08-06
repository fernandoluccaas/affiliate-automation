import React from "react";
import { render, screen } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Button } from "../components/ui/button";

vi.mock("@/components/admin-shell", () => ({
  AdminShell: ({
    actions,
    children,
    title,
  }: {
    actions?: React.ReactNode;
    children: React.ReactNode;
    title: string;
  }) => (
    <div>
      <h1>{title}</h1>
      {actions}
      {children}
    </div>
  ),
}));

vi.mock("@/lib/dashboard-metrics", () => ({
  getDashboardMetrics: vi.fn(async () => ({
    readyOffers: 2,
    publicationsToday: 1,
    clicksToday: 3,
    openAlerts: 0,
    clickSeries: [],
  })),
}));

vi.mock("./dashboard-chart", () => ({
  DashboardChart: () => <div aria-label="Gráfico do dashboard" />,
}));

import DashboardPage from "./page";

beforeAll(() => vi.stubGlobal("React", React));
afterAll(() => vi.unstubAllGlobals());

describe("Button", () => {
  it("renders accessible button text", () => {
    render(<Button>Entrar</Button>);

    expect(screen.getByRole("button", { name: "Entrar" })).toBeInTheDocument();
  });
});

describe("DashboardPage", () => {
  it("renders Revisar ofertas as a valid link without a wrapping button", async () => {
    render(await DashboardPage());

    const action = screen.getByRole("link", { name: "Revisar ofertas" });
    expect(action).toHaveAttribute("href", "/ofertas");
    expect(action.tagName).toBe("A");
    expect(action.closest("button")).toBeNull();
    expect(
      screen.getByRole("heading", { name: "Dashboard operacional" }),
    ).toBeInTheDocument();
  });
});
