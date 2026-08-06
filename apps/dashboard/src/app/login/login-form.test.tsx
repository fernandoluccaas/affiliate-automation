import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/actions", () => ({
  loginAction: vi.fn(async () => ({})),
}));

import { LoginForm } from "./login-form";

describe("LoginForm", () => {
  it("provides persistent labels, initial focus and accessible submission", () => {
    render(<LoginForm />);
    expect(
      screen.getByRole("heading", { name: "Acesso administrativo" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toHaveFocus();
    expect(screen.getByLabelText("Senha")).toHaveAttribute(
      "autocomplete",
      "current-password",
    );
    expect(screen.getByRole("button", { name: "Entrar" })).toBeEnabled();
  });
});
