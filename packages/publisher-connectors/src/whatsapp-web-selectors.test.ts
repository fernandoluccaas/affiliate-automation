import { describe, expect, it } from "vitest";
import {
  whatsappWebAccessibleAliases,
  whatsappWebExactGroupResultSelectors,
  whatsappWebStableSelectors,
} from "./whatsapp-web-selectors";

describe("WhatsApp Web semantic selector strategies", () => {
  it.each([
    ["pt", ["Pesquisar", "Nova conversa", "Digite uma mensagem", "Anexar"]],
    ["en", ["Search", "New chat", "Type a message", "Attach"]],
    ["es", ["Buscar", "Nuevo chat", "Escribe un mensaje", "Adjuntar"]],
  ])("contains the required %s aliases", (_language, expected) => {
    const aliases = JSON.stringify(whatsappWebAccessibleAliases);
    for (const alias of expected) expect(aliases).toContain(alias);
  });

  it("scopes global search away from the conversation composer", () => {
    for (const selector of [
      ...whatsappWebStableSelectors.searchTrigger,
      ...whatsappWebStableSelectors.searchInput,
    ]) {
      expect(selector).toMatch(/#side|chat-list-search/);
      expect(selector).not.toContain("footer");
      expect(selector).not.toContain("#main");
    }
  });

  it("uses stable semantic selectors without dynamic class names", () => {
    const selectors = JSON.stringify(whatsappWebStableSelectors);
    expect(selectors).toContain("role");
    expect(selectors).toContain("aria-label");
    expect(selectors).not.toMatch(/\._[A-Za-z0-9]{5,}/);
  });

  it("provides PT/EN/ES send aliases and media-scoped fallback selectors", () => {
    expect(whatsappWebAccessibleAliases.send).toEqual(["Send", "Enviar"]);
    for (const selector of whatsappWebStableSelectors.mediaSendTrigger) {
      expect(selector).toMatch(/button|role='button'|data-testid='send'/);
      expect(selector).not.toMatch(/\._[A-Za-z0-9]{5,}/);
    }
  });

  it("builds only exact title-based group result selectors", () => {
    const selectors = whatsappWebExactGroupResultSelectors(
      'Grupo "Exato" [ofertas]',
    );
    expect(selectors.length).toBeGreaterThan(1);
    for (const selector of selectors) {
      expect(selector).toContain("[title=");
      expect(selector).not.toContain("*=");
      expect(selector).not.toContain("^=");
    }
  });
});
