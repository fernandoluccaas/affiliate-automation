import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("results dashboard contract", () => {
  it("is authenticated, read-only and does not expose tracking identifiers", async () => {
    const source = await readFile(resolve(process.cwd(), "src/app/resultados/page.tsx"), "utf8");
    const shell = await readFile(resolve(process.cwd(), "src/components/admin-shell.tsx"), "utf8");

    expect(source).toContain("<AdminShell");
    expect(shell).toContain("requireSession");
    expect(source).toContain("collectAnalytics");
    expect(source).toContain("366");
    expect(source).toContain("somente leitura");
    expect(source).not.toMatch(/confirm-import|deleteMany|updateMany|rawPayload|fingerprintHash|externalOrderId/);
    expect(source).not.toMatch(/dispatch|Playwright|WhatsApp|Telegram/);
  });
});
