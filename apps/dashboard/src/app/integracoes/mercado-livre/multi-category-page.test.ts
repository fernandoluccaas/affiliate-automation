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

  it("offers category addition in list, leaf detail and test result", () => {
    expect(source).toContain("Adicionar categoria");
    expect(source).toContain("Categoria adicionada");
    expect(source).toContain("configuredCategoryIds.has(selectedCategory.id)");
    expect(source).toContain("testedCategoryAlreadyConfigured");
    expect(source).toContain("Voltar às categorias");
    expect(source).toContain("Ver candidatos");
  });

  it("separates common workflows from diagnostics and advanced settings", () => {
    expect(source).toContain("Seções da integração Mercado Livre");
    expect(source).toContain("Configuração avançada da sessão");
    expect(source).toContain("Opções avançadas");
    expect(source).toContain("<DiagnosticsPanel");
  });
});
