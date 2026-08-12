import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("datafeed streaming architecture", () => {
  it("does not load production Datafeeds through readFile or readFileSync", async () => {
    const sources = await Promise.all([
      readFile(new URL("./parser.ts", import.meta.url), "utf8"),
      readFile(new URL("./discovery.ts", import.meta.url), "utf8"),
      readFile(new URL("./source.ts", import.meta.url), "utf8"),
    ]);
    const production = sources.join("\n");
    expect(production).not.toMatch(/\breadFile(?:Sync)?\s*\(/);
    expect(production).toContain("createReadStream");
    expect(production).toContain("highWaterMark");
    expect(production).toContain("drain");
  });

  it("does not import database, Telegram, WhatsApp, Playwright or external clients", async () => {
    const source = await readFile(
      new URL("./index.ts", import.meta.url),
      "utf8",
    );
    const packageJson = await readFile(
      new URL("../package.json", import.meta.url),
      "utf8",
    );
    expect(`${source}\n${packageJson}`).not.toMatch(
      /@affiliate\/database|telegram|whatsapp|playwright|openai/i,
    );
  });
});
