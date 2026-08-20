import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const app = (path: string) =>
  readFileSync(
    resolve(process.cwd(), "src/app/integracoes/shopee", path),
    "utf8",
  );
const lib = (path: string) =>
  readFileSync(resolve(process.cwd(), "src/lib", path), "utf8");

describe("Shopee dashboard architecture", () => {
  it("keeps the route as a Server Component with one client island", () => {
    const page = app("page.tsx");
    expect(page).not.toMatch(/^\s*["']use client["']/);
    expect(page).toContain("<ShopeeDatafeedConsole");
    expect(page).toContain("Links do Datafeed não verificados");
  });

  it("does not reload or navigate for local actions", () => {
    const source = app("shopee-datafeed-console.tsx");
    expect(source).not.toMatch(/router\.(push|replace|refresh)/);
    expect(source).not.toMatch(/window\.location/);
    expect(source).not.toMatch(/\bredirect\s*\(/);
    expect(lib("shopee-datafeed-actions.ts")).not.toContain("revalidatePath");
  });

  it("uses localized pending and accessible live feedback", () => {
    const source = app("shopee-datafeed-console.tsx");
    expect(source).toContain("aria-busy");
    expect(source).toContain("live");
    expect(source).toContain("activeOperation");
  });

  it("does not expose secret fields in client DTOs", () => {
    expect(app("shopee-types.ts")).not.toMatch(
      /secret|token|cookie|authorization|password/i,
    );
  });

  it("shows only credential readiness and never credential values", () => {
    const source = `${app("page.tsx")}\n${app("shopee-datafeed-console.tsx")}`;
    expect(source).toContain("openApiConfigured");
    expect(source).not.toMatch(
      /SHOPEE_OPEN_API_(APP_ID|SECRET)|authorization/i,
    );
  });

  it("does not contain operational publication or messaging calls", () => {
    const source = `${app("shopee-datafeed-console.tsx")}\n${lib("shopee-datafeed-actions.ts")}`;
    expect(source).not.toMatch(
      /prisma|createPublication|telegram|whatsapp|playwright|chromium/i,
    );
  });
});
