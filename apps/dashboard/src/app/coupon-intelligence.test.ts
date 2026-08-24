import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");

describe("Coupon Intelligence dashboard contracts", () => {
  it("shows applicability, effective price, freshness and source on coupons", () => {
    const page = source("./cupons/page.tsx");
    for (const label of [
      "Aplicabilidade",
      "Preço efetivo",
      "Validade",
      "Origem",
      "Cupom confirmado",
      "Cupom condicional",
      "Cupom expirando",
      "Cupom stale",
    ]) {
      expect(page).toContain(label);
    }
  });

  it("uses selected Offer coupons and structured Publication snapshots", () => {
    expect(source("./ofertas/page.tsx")).toContain(
      "where: { active: true, selected: true }",
    );
    const publications = source("./publicacoes/page.tsx");
    expect(publications).toContain("isCouponSnapshot");
    expect(publications).toContain("effectivePriceCalculated");
  });

  it("states current provider limitations without presenting a general failure", () => {
    expect(source("./integracoes/shopee/page.tsx")).toContain(
      "Descoberta de cupons indisponível",
    );
    expect(source("./integracoes/mercado-livre/page.tsx")).toContain(
      "Descoberta de cupons indisponível na integração/API oficial atualmente",
    );
  });
});
