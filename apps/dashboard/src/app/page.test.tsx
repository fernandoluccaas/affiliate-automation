import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Button } from "../components/ui/button";

describe("Button", () => {
  it("renders accessible button text", () => {
    render(<Button>Entrar</Button>);

    expect(screen.getByRole("button", { name: "Entrar" })).toBeInTheDocument();
  });
});
