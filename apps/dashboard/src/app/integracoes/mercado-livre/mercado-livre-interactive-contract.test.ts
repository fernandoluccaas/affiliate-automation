import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const readApp = (path: string) =>
  readFileSync(
    resolve(process.cwd(), "src/app/integracoes/mercado-livre", path),
    "utf8",
  );
const readLib = (path: string) =>
  readFileSync(resolve(process.cwd(), "src/lib", path), "utf8");

describe("Mercado Livre interactive architecture", () => {
  it("keeps the route as a Server Component and mounts focused client islands", () => {
    const page = readApp("page.tsx");
    expect(page).not.toMatch(/^\s*["']use client["']/);
    expect(page).toContain("<MercadoLivreCategoryExplorer");
    expect(page).toContain("<DiscoverySettingsForm");
    expect(page).toContain("<AffiliateSessionPanel");
    expect(page).toContain("<DiagnosticsPanel");
    expect(page).toContain("<noscript>");
  });

  it("does not navigate or refresh the route for local client interactions", () => {
    const source = [
      readApp("components/mercado-livre-category-explorer.tsx"),
      readApp("components/discovery-settings-form.tsx"),
      readApp("components/affiliate-session-panel.tsx"),
      readApp("components/diagnostics-panel.tsx"),
      readApp("mercado-livre-import-button.tsx"),
      readLib("mercadolivre-interactive-actions.ts"),
    ].join("\n");
    expect(source).not.toMatch(/router\.(push|replace|refresh)/);
    expect(source).not.toMatch(/window\.location/);
    expect(source).not.toMatch(/\bredirect\s*\(/);
    expect(source).not.toContain("revalidatePath");
  });

  it("uses semantic category actions and race-safe local state", () => {
    const source = readApp("components/mercado-livre-category-explorer.tsx");
    expect(source).toContain("getMercadoLivreCategoryChildrenAction");
    expect(source).toContain("testMercadoLivreCategoryInteractiveAction");
    expect(source).toContain("addMercadoLivreCategoryInteractiveAction");
    expect(source).toContain("requestSequence");
    expect(source).toContain('aria-live="polite"');
    expect(source).not.toContain("?categoryId=");
  });

  it("returns explicit serializable DTOs without secret fields", () => {
    const types = readApp("mercado-livre-interactive-types.ts");
    expect(types).toContain("InteractiveActionResult");
    expect(types).toContain("MercadoLivreCategoryBrowserDto");
    expect(types).not.toMatch(
      /cookie|csrf|accessToken|refreshToken|authorization|secret/i,
    );
  });

  it("does not alter affiliate-link generation or publication contracts", () => {
    const explorer = readApp("components/mercado-livre-category-explorer.tsx");
    const settings = readApp("components/discovery-settings-form.tsx");
    expect(`${explorer}\n${settings}`).not.toMatch(
      /affiliateUrl|MercadoLivreAffiliateLinkService|Publication|publish/i,
    );
  });
});
