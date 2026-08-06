import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const pages = [
  "page.tsx",
  "produtos/page.tsx",
  "ofertas/page.tsx",
  "ofertas/nova/page.tsx",
  "ofertas/affiliate-links/page.tsx",
  "cupons/page.tsx",
  "canais/page.tsx",
  "publicacoes/page.tsx",
  "publicacoes-assistidas/page.tsx",
  "automacoes/page.tsx",
  "integracoes/page.tsx",
  "integracoes/mercado-livre/page.tsx",
  "resultados/page.tsx",
  "operacoes/page.tsx",
  "logs/page.tsx",
  "configuracoes/page.tsx",
];

const source = (path: string) =>
  readFileSync(resolve(process.cwd(), "src/app", path), "utf8");

describe("dashboard page migration contract", () => {
  it.each(pages)("keeps %s inside the authenticated AdminShell", (page) => {
    expect(source(page)).toContain("<AdminShell");
  });

  it("keeps external dispatch and browser automation out of redesigned UI components", () => {
    const clientUi = [
      source("page.tsx"),
      source("produtos/page.tsx"),
      source("ofertas/page.tsx"),
      source("resultados/page.tsx"),
      source("operacoes/page.tsx"),
    ].join("\n");
    expect(clientUi).not.toMatch(
      /playwright|chromium\.launch|dispatch-authorized|sendMessage\(/i,
    );
  });

  it("does not render the saved Mercado Livre cookie", () => {
    const mercadoLivre = source("integracoes/mercado-livre/page.tsx");
    expect(mercadoLivre).toContain("O valor salvo nunca é exibido");
    expect(mercadoLivre).not.toMatch(
      /defaultValue=\{affiliateSession\?\.(cookie|encryptedCookie)/,
    );
  });

  it("keeps technical WhatsApp commands separate from execution", () => {
    const publications = source("publicacoes/page.tsx");
    expect(publications).toMatch(/não executados\s+pelo dashboard/);
    expect(publications).toContain("WhatsAppPublicationStepper");
    expect(publications).not.toContain("whatsapp:web:dispatch-authorized");
  });
});
