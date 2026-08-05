import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createShopeeSubId,
  importShopeeCsv,
  inspectShopeeCsv,
  parseShopeeAffiliateCsv,
  sanitizeShopeeOperationalError,
  shopeeAffiliateStatus,
  shopeeCsvMaxBytes,
  shopeeOpenApiPreflight,
  validateShopeeUrl,
} from "./index";

const header = "Product ID,Shop ID,Product Name,Current Price,Product Link,Offer Link,Commission Rate";
const valid = `${header}\n10,20,"Cafeteira, Elétrica","129,90",https://shopee.com.br/product/20/10,https://shope.ee/safe,8%`;

afterEach(() => vi.unstubAllEnvs());

function inspection() {
  const parsed = parseShopeeAffiliateCsv(valid);
  return {
    ...parsed,
    summary: {
      totalRows: 1,
      validRows: 1,
      invalidRows: 0,
      duplicates: 0,
      newProducts: 1,
      existingProducts: 0,
      newOffers: 1,
      updatableOffers: 0,
      ignoredRows: 0,
      errorsByCode: {},
    },
  };
}

describe("Shopee affiliate safe configuration", () => {
  it("defaults missing, empty, disabled and unknown configuration to OFF", () => {
    expect(shopeeAffiliateStatus({}).mode).toBe("OFF");
    expect(shopeeAffiliateStatus({ SHOPEE_AFFILIATE_ENABLED: "false", SHOPEE_AFFILIATE_MODE: "CSV" }).mode).toBe("OFF");
    expect(shopeeAffiliateStatus({ SHOPEE_AFFILIATE_ENABLED: "true", SHOPEE_AFFILIATE_MODE: "UNKNOWN" })).toMatchObject({ mode: "OFF", configurationValid: false });
  });

  it("uses a bounded safe CSV size for invalid or excessive configuration", () => {
    expect(shopeeCsvMaxBytes({ SHOPEE_AFFILIATE_CSV_MAX_BYTES: "invalid" })).toBe(5_000_000);
    expect(shopeeCsvMaxBytes({ SHOPEE_AFFILIATE_CSV_MAX_BYTES: "999999999" })).toBe(50_000_000);
  });

  it("enables CSV without credentials and keeps Open API waiting", () => {
    expect(shopeeAffiliateStatus({ SHOPEE_AFFILIATE_ENABLED: "true", SHOPEE_AFFILIATE_MODE: "CSV" })).toMatchObject({ mode: "CSV", credentialsConfigured: false });
    expect(shopeeOpenApiPreflight({ SHOPEE_AFFILIATE_ENABLED: "true", SHOPEE_AFFILIATE_MODE: "OPEN_API", SHOPEE_AFFILIATE_APP_ID: "configured", SHOPEE_AFFILIATE_SECRET: "configured" })).toMatchObject({ state: "WAITING_FOR_OFFICIAL_ACCESS", documentationConfirmed: false, endpointsConfirmed: false, externalRequestsEnabled: false });
  });

  it("fails the Open API preflight closed when credentials or contracts are missing", () => {
    expect(shopeeOpenApiPreflight({
      SHOPEE_AFFILIATE_ENABLED: "true",
      SHOPEE_AFFILIATE_MODE: "OPEN_API",
    })).toMatchObject({
      event: "SHOPEE_API_PREFLIGHT",
      ready: false,
      blockers: expect.arrayContaining([
        "CREDENTIALS_NOT_CONFIGURED",
        "OFFICIAL_DOCUMENTATION_NOT_CONFIRMED",
      ]),
    });
  });
});

describe("official CSV parser", () => {
  it("parses BOM, comma, quoted fields, Portuguese characters and localized decimals", () => {
    const result = parseShopeeAffiliateCsv(`\uFEFF${valid}`);
    expect(result.rows[0]).toMatchObject({ identity: "20:10", title: "Cafeteira, Elétrica", currentPrice: 129.9, commissionPercentage: 8 });
    expect(result.issues).toEqual([]);
  });

  it("parses semicolon exports and escaped quotes", () => {
    const result = parseShopeeAffiliateCsv('Product ID;Shop ID;Product Name;Current Price;Product Link\n10;20;"Fone ""Bluetooth""";79,90;https://shopee.com.br/product/20/10');
    expect(result.rows[0]).toMatchObject({ title: 'Fone "Bluetooth"', currentPrice: 79.9 });
  });

  it.each([
    ["", "EMPTY_FILE"],
    ["Product ID,Shop ID", "MISSING_COLUMN_TITLE"],
    [`${header}\n10,20,Produto,10,not-a-url,,`, "INVALID_PRODUCT_URL"],
    [`${header}\n10,20,Produto,10,https://evil.example/item,https://shope.ee/safe,`, "INVALID_PRODUCT_URL"],
    [`${header}\n10,20,Produto,10,https://shopee.com.br/product/20/10,https://evil.example/tracking,`, "INVALID_AFFILIATE_URL"],
  ])("rejects invalid input safely", (csv, code) => {
    expect(parseShopeeAffiliateCsv(csv).issues.map((issue) => issue.code)).toContain(code);
  });

  it("reports duplicate rows and deterministically hashes files", () => {
    const csv = `${valid}\n10,20,Duplicado,129.90,https://shopee.com.br/product/20/10,,8`;
    const first = parseShopeeAffiliateCsv(csv);
    expect(first.duplicates).toBe(1);
    expect(first.issues).toContainEqual({ line: 3, code: "DUPLICATE_ROW" });
    expect(first.checksum).toBe(createHash("sha256").update(csv).digest("hex"));
    expect(parseShopeeAffiliateCsv(csv).checksum).toBe(first.checksum);
  });

  it("rejects excessive files and does not interpret spreadsheet formulas", () => {
    expect(parseShopeeAffiliateCsv(valid, 10).issues[0]?.code).toBe("FILE_TOO_LARGE");
    const result = parseShopeeAffiliateCsv(`${header}\n10,20,=HYPERLINK(evil),10,https://shopee.com.br/product/20/10,,`);
    expect(result.rows[0]?.title).toBe("=HYPERLINK(evil)");
  });

  it("uses documented URL identity fallback when shop id is absent", () => {
    const result = parseShopeeAffiliateCsv("Product ID,Product Name,Current Price,Product Link\n10,Produto,10,https://shopee.com.br/product/20/10");
    expect(result.rows[0]?.identity).toMatch(/^url:[a-f0-9]{24}$/);
    const tracked = parseShopeeAffiliateCsv("Product ID,Product Name,Current Price,Product Link\n10,Produto,10,https://shopee.com.br/product/20/10?utm_source=official#fragment");
    expect(tracked.rows[0]?.identity).toBe(result.rows[0]?.identity);
  });

  it("keeps missing commission and affiliate link null", () => {
    const result = parseShopeeAffiliateCsv("Product ID,Shop ID,Product Name,Current Price,Product Link\n10,20,Produto,10,https://shopee.com.br/product/20/10");
    expect(result.rows[0]).toMatchObject({ commissionPercentage: null, affiliateUrl: null });
  });
});

describe("inspection and safety", () => {
  it("counts existing and new products without writing", async () => {
    const database = { product: { findMany: vi.fn(async () => [{ externalProductId: "200001:100001", offers: [{ id: "offer-1" }] }]) } };
    const result = await inspectShopeeCsv(resolve("fixtures/official-export-sanitized.csv"), database as never);
    expect(result.summary).toMatchObject({ validRows: 2, existingProducts: 1, newProducts: 1, newOffers: 1, updatableOffers: 1 });
    expect(database.product.findMany).toHaveBeenCalledOnce();
  });

  it("rejects missing files, traversal and non-CSV extensions", async () => {
    await expect(inspectShopeeCsv("../secret.csv")).rejects.toThrow("SHOPEE_CSV_PATH_INVALID");
    await expect(inspectShopeeCsv("missing.csv")).rejects.toThrow();
    const root = await mkdtemp(join(tmpdir(), "shopee-test-"));
    const file = join(root, "payload.txt");
    await writeFile(file, valid);
    await expect(inspectShopeeCsv(file)).rejects.toThrow("SHOPEE_CSV_PATH_INVALID");
  });

  it("accepts exact/subdomains and rejects lookalikes, HTTP and credentials", () => {
    expect(validateShopeeUrl("https://shopee.com.br/item")).toBe(true);
    expect(validateShopeeUrl("https://affiliate.shopee.com.br/item")).toBe(true);
    expect(validateShopeeUrl("https://shopee.com.br.evil.test/item")).toBe(false);
    expect(validateShopeeUrl("http://shopee.com.br/item")).toBe(false);
    expect(validateShopeeUrl("https://user:pass@shopee.com.br/item")).toBe(false);
  });

  it("creates deterministic sanitized Sub IDs without private text", () => {
    const first = createShopeeSubId({ channel: "telegram-01", publication: "pub_123", origin: "csv", campaign: "verao 2026", variant: "A" });
    expect(first).toBe(createShopeeSubId({ channel: "telegram-01", publication: "pub_123", origin: "csv", campaign: "verao 2026", variant: "A" }));
    expect(first).toMatch(/^[a-z0-9_-]+$/);
    expect(first.length).toBeLessThanOrEqual(128);
  });

  it("contains no external HTTP client or browser runtime", async () => {
    const source = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("./index.ts", import.meta.url), "utf8"));
    expect(source).not.toMatch(/playwright|puppeteer|axios|fetch\s*\(/i);
  });

  it("never exposes secrets or full URLs from operational errors", () => {
    expect(sanitizeShopeeOperationalError(new Error("token=secret https://shopee.example/private"))).toBe("SHOPEE_OPERATION_FAILED");
    expect(sanitizeShopeeOperationalError(new Error("SHOPEE_CSV_NOT_FILE"))).toBe("SHOPEE_CSV_NOT_FILE");
  });
});

describe("confirmed CSV import", () => {
  function setup(input: { duplicate?: boolean; transactionFailure?: boolean; updated?: boolean } = {}) {
    vi.stubEnv("SHOPEE_AFFILIATE_ENABLED", "true");
    vi.stubEnv("SHOPEE_AFFILIATE_MODE", "CSV");
    const release = vi.fn(async () => undefined);
    const itemCreate = vi.fn(async () => ({ id: "item-1" }));
    const jobUpdate = vi.fn(async () => ({ id: "job-1" }));
    const transaction = vi.fn(async (callback: (transactionClient: unknown) => Promise<unknown>) => {
      if (input.transactionFailure) throw new Error("simulated transaction failure");
      return callback({ importJobItem: { create: itemCreate }, importJob: { update: jobUpdate } });
    });
    const database = {
      importJob: {
        findFirst: vi.fn(async () => input.duplicate ? { id: "existing-job", summary: { checksum: "safe" } } : null),
        create: vi.fn(async () => ({ id: "job-1" })),
        update: jobUpdate,
      },
      $transaction: transaction,
    };
    const ingest = vi.fn(async () => ({
      ok: true,
      status: "READY_TO_PUBLISH",
      statusReason: "VALIDATED",
      productId: "product-1",
      offerId: "offer-1",
      offerCreated: !input.updated,
      offerUpdated: Boolean(input.updated),
    }));
    return {
      database,
      release,
      itemCreate,
      jobUpdate,
      transaction,
      ingest,
      dependencies: {
        database: database as never,
        inspect: vi.fn(async () => inspection()) as never,
        acquire: vi.fn(async () => ({ acquired: true, release })) as never,
        ingest: ingest as never,
      },
    };
  }

  it("requires confirmation and performs no database write in dry-run", async () => {
    const context = setup();
    const withoutConfirmation = await importShopeeCsv(
      { file: "safe.csv", confirm: false, dryRun: false },
      context.dependencies,
    );
    const explicitDryRun = await importShopeeCsv(
      { file: "safe.csv", confirm: true, dryRun: true },
      context.dependencies,
    );
    expect(withoutConfirmation).toMatchObject({ status: "DRY_RUN", databaseWrites: 0 });
    expect(explicitDryRun).toMatchObject({ status: "DRY_RUN", databaseWrites: 0 });
    expect(context.database.importJob.create).not.toHaveBeenCalled();
    expect(context.transaction).not.toHaveBeenCalled();
  });

  it("imports through the existing ingestion pipeline and records job items", async () => {
    const context = setup();
    const result = await importShopeeCsv(
      { file: "safe.csv", confirm: true, dryRun: false },
      context.dependencies,
    );
    expect(result).toMatchObject({ status: "SUCCEEDED", created: 1, updated: 0, failed: 0 });
    expect(context.ingest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ marketplace: "SHOPEE", externalProductId: "20:10", affiliateUrl: "https://shope.ee/safe" }),
      expect.anything(),
    );
    expect(context.itemCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ productId: "product-1", offerId: "offer-1" }) }));
    expect(context.jobUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "SUCCEEDED", totalCreated: 1 }) }));
    expect(context.release).toHaveBeenCalledOnce();
  });

  it("reports an existing product offer update without duplicating the product", async () => {
    const context = setup({ updated: true });
    const result = await importShopeeCsv(
      { file: "safe.csv", confirm: true, dryRun: false },
      context.dependencies,
    );
    expect(result).toMatchObject({ created: 0, updated: 1 });
    expect(context.ingest).toHaveBeenCalledOnce();
  });

  it("treats an already successful checksum as an idempotent duplicate", async () => {
    const context = setup({ duplicate: true });
    const result = await importShopeeCsv(
      { file: "same.csv", confirm: true, dryRun: false },
      context.dependencies,
    );
    expect(result).toMatchObject({ status: "DUPLICATE_FILE", importJobId: "existing-job", databaseWrites: 1 });
    expect(context.database.importJob.create).not.toHaveBeenCalled();
    expect(context.ingest).not.toHaveBeenCalled();
    expect(context.database.importJob.update).toHaveBeenCalledWith(expect.objectContaining({ data: { summary: expect.objectContaining({ duplicateAttempts: 1 }) } }));
    expect(context.release).toHaveBeenCalledOnce();
  });

  it("fails closed when the Redis lock is already held", async () => {
    const context = setup();
    const dependencies = {
      ...context.dependencies,
      acquire: vi.fn(async () => ({ acquired: false, reason: "LOCKED" })) as never,
    };
    await expect(importShopeeCsv(
      { file: "safe.csv", confirm: true, dryRun: false },
      dependencies,
    )).rejects.toThrow("SHOPEE_IMPORT_ALREADY_RUNNING");
    expect(context.database.importJob.create).not.toHaveBeenCalled();
  });

  it("rolls back business writes, records a sanitized failure and releases the lock", async () => {
    const context = setup({ transactionFailure: true });
    await expect(importShopeeCsv(
      { file: "safe.csv", confirm: true, dryRun: false },
      context.dependencies,
    )).rejects.toThrow("simulated transaction failure");
    expect(context.database.importJob.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "FAILED", errorMessage: "SHOPEE_IMPORT_TRANSACTION_FAILED" }) }));
    expect(context.release).toHaveBeenCalledOnce();
  });
});
