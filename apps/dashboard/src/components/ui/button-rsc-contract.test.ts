// @vitest-environment node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buttonVariants } from "@/components/ui/button-variants";

const readSource = (path: string) =>
  readFileSync(resolve(process.cwd(), "src", path), "utf8");

describe("Button React Server Component contract", () => {
  it("keeps Button behind an explicit client boundary", () => {
    const button = readSource("components/ui/button.tsx");
    expect(button.startsWith('"use client";')).toBe(true);
    expect(button).toContain('from "@/components/ui/button-variants"');
    expect(button).toContain("onClick={(event) =>");
  });

  it("keeps buttonVariants importable from a pure server-safe module", () => {
    const variants = readSource("components/ui/button-variants.ts");
    expect(variants).not.toMatch(/["']use client["']/);
    expect(variants).not.toMatch(/@radix-ui\/react-slot|\bSlot\b|onClick|window|document/);
    expect(buttonVariants({ variant: "outline" })).toContain("border");
  });

  it("keeps the dashboard and AdminShell as Server Components", () => {
    const dashboard = readSource("app/page.tsx");
    const adminShell = readSource("components/admin-shell.tsx");
    const adminShellClient = readSource("components/admin-shell-client.tsx");

    expect(dashboard).not.toMatch(/^["']use client["']/);
    expect(adminShell).not.toMatch(/^["']use client["']/);
    expect(adminShellClient.startsWith('"use client";')).toBe(true);
    expect(dashboard).toContain("<Button asChild");
    expect(dashboard).not.toContain("onClick=");
    expect(adminShell).toContain("actions?: React.ReactNode");
    expect(adminShell).toContain("<AdminShellClient");
    expect(adminShellClient).toContain("actions?: React.ReactNode");
  });

  it("prevents event handlers from being created in the server-side action tree", () => {
    const dashboard = readSource("app/page.tsx");
    const button = readSource("components/ui/button.tsx");

    expect(dashboard).toMatch(
      /<Button\s+asChild\s+variant="outline">\s*<Link\s+href="\/ofertas">Revisar ofertas<\/Link>/,
    );
    expect(dashboard).not.toMatch(/onClick|onPointerDown|onKeyDown/);
    expect(button.indexOf('"use client";')).toBeLessThan(
      button.indexOf("onClick={(event) =>"),
    );
  });
});
