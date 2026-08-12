import { Readable } from "node:stream";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { streamShopeeDatafeed } from "./parser";
import {
  SHOPEE_BRAZIL_HEADERS,
  SHOPEE_OFFICIAL_BR_HEADERS,
  identifyShopeeDatafeedSchema,
} from "./schema";
import { LocalFileDatafeedSource } from "./source";
import type { DatafeedSource, ShopeeDatafeedProduct } from "./types";

const officialFixture = fileURLToPath(
  new URL("../fixtures/shopee-official-br-sanitized.csv", import.meta.url),
);
const brazilFixture = fileURLToPath(
  new URL("../fixtures/shopee-brasil-sanitized.csv", import.meta.url),
);

function sourceFrom(
  text: string,
  release = vi.fn(async () => undefined),
): DatafeedSource {
  return {
    kind: "LOCAL_FILE",
    async open() {
      return {
        metadata: {
          kind: "LOCAL_FILE",
          name: "fixture.csv",
          absolutePath: "C:\\fixture.csv",
          size: Buffer.byteLength(text),
          modifiedAt: new Date(0).toISOString(),
          fingerprint: "fixture",
        },
        stream: Readable.from([Buffer.from(text)]),
        release,
      };
    },
  };
}

function brazilRow(overrides: Record<number, string> = {}) {
  const values = [
    "https://cf.shopee.com.br/file/image",
    "123",
    "150",
    "Home & Living",
    "description",
    "Decor",
    "",
    "4.9",
    "100",
    "20",
    "33",
    "",
    "Produto",
    "10",
    "https://shopee.com.br/produto-i.1.123",
    "https://shope.ee/an_redir?origin_link=x",
  ];
  for (const [index, value] of Object.entries(overrides))
    values[Number(index)] = value;
  return values
    .map((value) =>
      /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value,
    )
    .join(",");
}

async function parseText(text: string) {
  const products: ShopeeDatafeedProduct[] = [];
  const issues: string[] = [];
  const summary = await streamShopeeDatafeed({
    file: "fixture.csv",
    source: sourceFrom(text),
    linksVerified: false,
    maxFileBytes: 10_000_000,
    onProduct: (product) => {
      products.push(product);
    },
    onIssue: (issue) => {
      issues.push(issue.code);
    },
  });
  return { products, issues, summary };
}

describe("streaming Shopee CSV parser", () => {
  it("identifies the exact Oficial BR schema", () => {
    expect(identifyShopeeDatafeedSchema([...SHOPEE_OFFICIAL_BR_HEADERS])).toBe(
      "OFFICIAL_BR",
    );
  });

  it("identifies the exact Shopee Brasil schema including product_short link", () => {
    expect(identifyShopeeDatafeedSchema([...SHOPEE_BRAZIL_HEADERS])).toBe(
      "BRAZIL",
    );
  });

  it("does not normalize a wrong header before schema validation", () => {
    expect(
      identifyShopeeDatafeedSchema(
        SHOPEE_BRAZIL_HEADERS.map((header) => header.replace(" ", "_")),
      ),
    ).toBeNull();
  });

  it("parses the Oficial BR fixture with a multiline quoted description", async () => {
    const content = await readFile(officialFixture, "utf8");
    const { products, summary } = await parseText(content);
    expect(summary).toMatchObject({
      schema: "OFFICIAL_BR",
      rowsProcessed: 5,
      validRows: 4,
      invalidRows: 1,
    });
    expect(products[0]?.description).toContain("\ne bateria");
  });

  it("parses the BOM in the Shopee Brasil fixture", async () => {
    const content = await readFile(brazilFixture);
    expect([...content.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const result = await parseText(content.toString("utf8"));
    expect(result.summary.schema).toBe("BRAZIL");
  });

  it("supports CRLF and quoted commas", async () => {
    const text = `${SHOPEE_BRAZIL_HEADERS.join(",")}\r\n${brazilRow({ 4: "linha um, com vírgula\r\nlinha dois" })}\r\n`;
    const result = await parseText(text);
    expect(result.products[0]?.description).toContain("linha dois");
    expect(result.summary.validRows).toBe(1);
  });

  it("supports empty fields and a correct EOF without newline", async () => {
    const result = await parseText(
      `${SHOPEE_BRAZIL_HEADERS.join(",")}\n${brazilRow({ 2: "", 10: "", 11: "" })}`,
    );
    expect(result.products[0]).toMatchObject({
      originalPrice: null,
      discountPercentage: null,
      secondaryImageUrl: null,
    });
  });

  it("reports invalid rows without cancelling valid rows", async () => {
    const text = `${SHOPEE_BRAZIL_HEADERS.join(",")}\n${brazilRow()}\n${brazilRow({ 1: "", 12: "Inválido" })}\n`;
    const result = await parseText(text);
    expect(result.summary).toMatchObject({ validRows: 1, invalidRows: 1 });
    expect(result.issues).toEqual(["INVALID_ITEM_ID"]);
  });

  it("rejects a column count mismatch", async () => {
    const result = await parseText(
      `${SHOPEE_BRAZIL_HEADERS.join(",")}\nonly,three,columns\n`,
    );
    expect(result.issues).toEqual(["COLUMN_COUNT_MISMATCH"]);
  });

  it("fails closed for an unsupported schema", async () => {
    await expect(parseText("itemid,title\n1,Produto\n")).rejects.toThrow(
      "SHOPEE_DATAFEED_SCHEMA_UNSUPPORTED",
    );
  });

  it("releases the source when parsing fails", async () => {
    const release = vi.fn(async () => undefined);
    await expect(
      streamShopeeDatafeed({
        file: "fixture.csv",
        source: sourceFrom("bad,header\n1,2", release),
        linksVerified: false,
        maxFileBytes: 1_000,
        onProduct: vi.fn(),
      }),
    ).rejects.toThrow();
    expect(release).toHaveBeenCalledOnce();
  });

  it("processes many generated records incrementally", async () => {
    const rows = Array.from({ length: 2_000 }, (_, index) =>
      brazilRow({ 1: String(index + 1) }),
    );
    const result = await parseText(
      `${SHOPEE_BRAZIL_HEADERS.join(",")}\n${rows.join("\n")}\n`,
    );
    expect(result.summary.validRows).toBe(2_000);
    expect(result.summary.checksum).toMatch(/^[a-f0-9]{64}$/);
  });

  it("locks the same local file until the active stream is released", async () => {
    const directory = await mkdtemp(join(tmpdir(), "shopee-lock-test-"));
    const file = join(directory, "fixture.csv");
    await writeFile(file, `${SHOPEE_BRAZIL_HEADERS.join(",")}\n${brazilRow()}\n`, "utf8");
    const source = new LocalFileDatafeedSource();
    const first = await source.open({ location: file, maxBytes: 1_000_000 });
    try {
      await expect(source.open({ location: file, maxBytes: 1_000_000 })).rejects.toThrow("SHOPEE_DATAFEED_ALREADY_PROCESSING");
    } finally {
      first.stream.destroy();
      await first.release();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
