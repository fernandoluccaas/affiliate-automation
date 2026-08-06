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

const componentSource = (path: string) =>
  readFileSync(resolve(process.cwd(), "src/components", path), "utf8");

const asChildConsumerPages = [
  "page.tsx",
  "produtos/page.tsx",
  "ofertas/page.tsx",
  "ofertas/nova/offer-form.tsx",
  "ofertas/affiliate-links/page.tsx",
  "integracoes/page.tsx",
  "integracoes/mercado-livre/page.tsx",
];

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

  it("renders the dashboard Revisar ofertas action through a polymorphic link", () => {
    const dashboard = source("page.tsx");
    expect(dashboard).toMatch(
      /<Button\s+asChild\s+variant="outline">\s*<Link\s+href="\/ofertas">Revisar ofertas<\/Link>\s*<\/Button>/,
    );
  });

  it("keeps every Button asChild consumer composed with one Link or anchor", () => {
    const consumers = asChildConsumerPages
      .map((path) => source(path))
      .concat(componentSource("empty-state.tsx"))
      .join("\n");
    const openings = consumers.match(/<Button\b(?=[^>]*\basChild\b)[^>]*>/g) ?? [];
    const validCompositions =
      consumers.match(
        /<Button\b(?=[^>]*\basChild\b)[^>]*>\s*<(Link|a)\b[\s\S]*?<\/\1>\s*<\/Button>/g,
      ) ?? [];

    expect(openings.length).toBeGreaterThan(0);
    expect(validCompositions).toHaveLength(openings.length);
    expect(openings.every((opening) => !/\bloading\b/.test(opening))).toBe(true);
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
