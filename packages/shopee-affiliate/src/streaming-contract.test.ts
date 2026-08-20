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

  it("keeps database access out of parser/discovery and prohibited integrations out of the package", async () => {
    const streamingSources = await Promise.all([
      readFile(new URL("./parser.ts", import.meta.url), "utf8"),
      readFile(new URL("./discovery.ts", import.meta.url), "utf8"),
      readFile(new URL("./source.ts", import.meta.url), "utf8"),
    ]);
    expect(streamingSources.join("\n")).not.toMatch(/@affiliate\/database/i);
    const packageJson = await readFile(
      new URL("../package.json", import.meta.url),
      "utf8",
    );
    expect(packageJson).not.toMatch(/telegram|whatsapp|playwright|openai/i);
  });

  it("routes operational persistence through ingestion and never creates Publications", async () => {
    const source = await readFile(
      new URL("./operational.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("ingestOfferInTransaction");
    expect(source).toContain("reusableAffiliateUrl");
    expect(
      source.indexOf("const reusable = await database.$transaction"),
    ).toBeLessThan(source.indexOf("const generated = await provider.resolve"));
    expect(source).not.toContain("input.linkProvider.resolve");
    expect(source).not.toMatch(
      /(?:database|tx)\.publication\.(?:create|update)/i,
    );
  });
});
