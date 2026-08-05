import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Shopee integration dashboard card", () => {
  it("is read-only and does not expose an import or publication action", async () => {
    const source = await readFile(resolve("src/app/integracoes/page.tsx"), "utf8");
    const start = source.indexOf("Shopee Afiliados");
    const end = source.indexOf("Ollama", start);
    const card = source.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(card).toContain("shopee.mode");
    expect(card).toContain("shopee.state");
    expect(card).toContain("Área somente leitura");
    expect(card).not.toMatch(/<form|<button|type=["']file|action=/i);
  });
});
