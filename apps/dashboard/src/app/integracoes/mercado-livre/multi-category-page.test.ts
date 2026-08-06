import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(process.cwd(), "src/app/integracoes/mercado-livre/page.tsx"),
  "utf8",
);

describe("Mercado Livre multi-category dashboard", () => {
  it("exposes only configuration, preview context and session reporting", () => {
    expect(source).toContain("Habilitar seleção multicategoria balanceada");
    expect(source).toContain("Máximo total por sessão");
    expect(source).toContain("Sessão multicategoria");
    expect(source).toContain("categoryEnabled:");
    expect(source).toContain("sessionFilter");
    expect(source).toContain("categoryFilter");
    expect(source).toContain("statusFilter");
    expect(source).toContain("dateFilter");
    expect(source).not.toContain("dispatch-authorized");
  });
});
