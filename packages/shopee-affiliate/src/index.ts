import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { prisma } from "@affiliate/database";
import { ingestOfferInTransaction } from "@affiliate/ingestion";
import { acquireLock } from "@affiliate/redis";
import { validateMarketplaceAffiliateUrl } from "@affiliate/validation";

export type ShopeeAffiliateMode = "OFF" | "CSV" | "OPEN_API";

export function sanitizeShopeeOperationalError(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  return /^[A-Z0-9_]+$/.test(message) ? message : "SHOPEE_OPERATION_FAILED";
}

export function shopeeCsvMaxBytes(env: NodeJS.ProcessEnv = process.env) {
  const configured = Number(env.SHOPEE_AFFILIATE_CSV_MAX_BYTES ?? 5_000_000);
  return Number.isSafeInteger(configured) && configured > 0
    ? Math.min(configured, 50_000_000)
    : 5_000_000;
}

export function shopeeAffiliateStatus(env: NodeJS.ProcessEnv = process.env) {
  const enabled = env.SHOPEE_AFFILIATE_ENABLED === "true";
  const rawMode = env.SHOPEE_AFFILIATE_MODE?.trim();
  const mode: ShopeeAffiliateMode = enabled && rawMode === "CSV"
    ? "CSV"
    : enabled && rawMode === "OPEN_API"
      ? "OPEN_API"
      : "OFF";
  const configurationValid = !enabled || rawMode === "CSV" || rawMode === "OPEN_API";
  const credentialsConfigured = Boolean(
    env.SHOPEE_AFFILIATE_APP_ID && env.SHOPEE_AFFILIATE_SECRET,
  );
  return {
    enabled: mode !== "OFF",
    mode,
    configurationValid,
    credentialsConfigured,
    state:
      !configurationValid
        ? "INVALID_CONFIGURATION"
        : mode === "OPEN_API"
          ? "WAITING_FOR_OFFICIAL_ACCESS"
          : mode === "CSV"
            ? "READY_FOR_LOCAL_CSV"
            : "DISABLED",
    externalRequestsEnabled: false,
  } as const;
}

export const SHOPEE_COLUMN_ALIASES = {
  productId: ["product id", "item id", "id do produto", "productid", "itemid"],
  shopId: ["shop id", "seller id", "id da loja", "shopid", "sellerid"],
  title: ["product name", "product title", "nome do produto", "titulo", "title"],
  currentPrice: ["current price", "sale price", "preco atual", "price"],
  originalPrice: ["original price", "list price", "preco original"],
  productUrl: ["product link", "product url", "link do produto", "url do produto"],
  affiliateUrl: ["offer link", "affiliate link", "link afiliado", "link da oferta"],
  commissionPercentage: ["commission rate", "commission percentage", "taxa de comissao", "comissao"],
  commission: ["commission", "commission amount", "valor da comissao"],
  category: ["category", "categoria"],
  imageUrl: ["image url", "image", "url da imagem"],
  seller: ["shop name", "seller", "loja", "vendedor"],
  currency: ["currency", "moeda"],
  availability: ["availability", "stock status", "disponibilidade"],
  validUntil: ["valid until", "expiration", "validade"],
  sourceTimestamp: ["updated at", "source timestamp", "data da origem"],
} as const;

export type ShopeeCsvIssue = { line: number; code: string };
export type ShopeeNormalizedRow = {
  line: number;
  identity: string;
  productId: string | null;
  shopId: string | null;
  title: string;
  currentPrice: number;
  originalPrice: number | null;
  productUrl: string;
  affiliateUrl: string | null;
  commissionPercentage: number | null;
  commission: number | null;
  category: string | null;
  imageUrl: string | null;
  seller: string | null;
  currency: string | null;
  availability: string | null;
  validUntil: string | null;
  sourceTimestamp: string | null;
};

function key(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parseRows(text: string, delimiter: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === '"') {
      if (quoted && text[index + 1] === '"') { value += '"'; index += 1; }
      else quoted = !quoted;
    } else if (char === delimiter && !quoted) { row.push(value.trim()); value = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(value.trim());
      if (row.some(Boolean)) rows.push(row);
      row = []; value = "";
    } else value += char;
  }
  row.push(value.trim());
  if (row.some(Boolean)) rows.push(row);
  return { rows, unclosedQuote: quoted };
}

function decimal(value: string | undefined, percentage = false) {
  if (!value?.trim()) return null;
  let normalized = value.trim().replace(/\s|R\$|%/gi, "");
  if (normalized.includes(",") && normalized.includes(".")) normalized = normalized.replace(/\./g, "").replace(",", ".");
  else normalized = normalized.replace(",", ".");
  const result = Number(normalized);
  return Number.isFinite(result) && result >= 0 && (!percentage || result <= 100) ? result : null;
}

const DOMAINS = ["shopee.com.br", "shopee.com", "shope.ee", "susercontent.com"];
export function validateShopeeUrl(value: string, image = false) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const allowed = DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
    return url.protocol === "https:" && !url.username && !url.password && allowed && (image || !host.endsWith("susercontent.com"));
  } catch { return false; }
}

function fallbackProductIdentity(value: string) {
  const url = new URL(value);
  url.hash = "";
  url.search = "";
  url.hostname = url.hostname.toLowerCase();
  url.pathname = url.pathname.replace(/\/$/, "");
  return `url:${createHash("sha256").update(url.toString()).digest("hex").slice(0, 24)}`;
}

function findIndex(headers: string[], aliases: readonly string[]) {
  return headers.findIndex((header) => aliases.includes(header));
}

export function parseShopeeAffiliateCsv(input: Buffer | string, maxBytes = 5_000_000) {
  const buffer = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  const checksum = createHash("sha256").update(buffer).digest("hex");
  if (buffer.byteLength > maxBytes) return { checksum, columns: [], rows: [], issues: [{ line: 0, code: "FILE_TOO_LARGE" }], duplicates: 0 };
  const text = buffer.toString("utf8").replace(/^\uFEFF/, "");
  if (!text.trim()) return { checksum, columns: [], rows: [], issues: [{ line: 0, code: "EMPTY_FILE" }], duplicates: 0 };
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ";" : ",";
  const parsed = parseRows(text, delimiter);
  if (parsed.unclosedQuote) return { checksum, columns: [], rows: [], issues: [{ line: 0, code: "UNCLOSED_QUOTE" }], duplicates: 0 };
  const [header = [], ...data] = parsed.rows;
  const headers = header.map(key);
  const indexes = Object.fromEntries(Object.entries(SHOPEE_COLUMN_ALIASES).map(([name, aliases]) => [name, findIndex(headers, aliases)])) as Record<keyof typeof SHOPEE_COLUMN_ALIASES, number>;
  const missing = (["title", "currentPrice", "productUrl"] as const).filter((name) => indexes[name] < 0);
  if (missing.length) return { checksum, columns: header, rows: [], issues: missing.map((name) => ({ line: 1, code: `MISSING_COLUMN_${name.toUpperCase()}` })), duplicates: 0 };
  const issues: ShopeeCsvIssue[] = [];
  const rows: ShopeeNormalizedRow[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  const get = (values: string[], name: keyof typeof SHOPEE_COLUMN_ALIASES) => indexes[name] >= 0 ? values[indexes[name]!]?.trim() ?? "" : "";
  data.forEach((values, offset) => {
    const line = offset + 2;
    const productUrl = get(values, "productUrl");
    const affiliateUrl = get(values, "affiliateUrl");
    const title = get(values, "title");
    const priceRaw = get(values, "currentPrice");
    const currentPrice = decimal(priceRaw);
    if (!title) { issues.push({ line, code: "MISSING_TITLE" }); return; }
    if (currentPrice === null || currentPrice <= 0) { issues.push({ line, code: "INVALID_CURRENT_PRICE" }); return; }
    if (!validateShopeeUrl(productUrl)) { issues.push({ line, code: "INVALID_PRODUCT_URL" }); return; }
    if (affiliateUrl && (!validateShopeeUrl(affiliateUrl) || !validateMarketplaceAffiliateUrl("SHOPEE", affiliateUrl).ok)) { issues.push({ line, code: "INVALID_AFFILIATE_URL" }); return; }
    const imageUrl = get(values, "imageUrl");
    if (imageUrl && !validateShopeeUrl(imageUrl, true)) { issues.push({ line, code: "INVALID_IMAGE_URL" }); return; }
    const productId = get(values, "productId") || null;
    const shopId = get(values, "shopId") || null;
    const identity = productId && shopId ? `${shopId}:${productId}` : fallbackProductIdentity(productUrl);
    if (seen.has(identity)) { duplicates += 1; issues.push({ line, code: "DUPLICATE_ROW" }); return; }
    seen.add(identity);
    const originalPrice = decimal(get(values, "originalPrice"));
    rows.push({ line, identity, productId, shopId, title, currentPrice, originalPrice: originalPrice !== null && originalPrice >= currentPrice ? originalPrice : null, productUrl, affiliateUrl: affiliateUrl || null, commissionPercentage: decimal(get(values, "commissionPercentage"), true), commission: decimal(get(values, "commission")), category: get(values, "category") || null, imageUrl: imageUrl || null, seller: get(values, "seller") || null, currency: get(values, "currency") || null, availability: get(values, "availability") || null, validUntil: get(values, "validUntil") || null, sourceTimestamp: get(values, "sourceTimestamp") || null });
  });
  return { checksum, delimiter, columns: header, rows, issues, duplicates };
}

export function createShopeeSubId(parts: { channel?: string; publication?: string; origin?: string; campaign?: string; variant?: string }) {
  return Object.entries(parts).flatMap(([name, value]) => value ? [`${name.slice(0, 3)}_${value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24)}`] : []).join("__").slice(0, 128);
}

export async function inspectShopeeCsv(file: string, database = prisma) {
  if (file.split(/[\\/]/).includes("..") || extname(file).toLowerCase() !== ".csv") throw new Error("SHOPEE_CSV_PATH_INVALID");
  const absolute = resolve(file);
  const info = await stat(absolute);
  if (!info.isFile()) throw new Error("SHOPEE_CSV_NOT_FILE");
  const maxBytes = shopeeCsvMaxBytes();
  if (info.size > maxBytes) throw new Error("SHOPEE_CSV_FILE_TOO_LARGE");
  const parsed = parseShopeeAffiliateCsv(await readFile(absolute), maxBytes);
  const identities = parsed.rows.map((row) => row.identity);
  const existing = identities.length ? await database.product.findMany({ where: { marketplace: "SHOPEE", externalProductId: { in: identities } }, select: { externalProductId: true, offers: { orderBy: { version: "desc" }, take: 1, select: { id: true } } } }) : [];
  const existingIds = new Set(existing.map((item) => item.externalProductId));
  const identitiesWithOffers = new Set(existing.filter((item) => item.offers.length > 0).map((item) => item.externalProductId));
  return { ...parsed, summary: { totalRows: parsed.rows.length + parsed.issues.filter((issue) => issue.line > 1).length, validRows: parsed.rows.length, invalidRows: parsed.issues.length, duplicates: parsed.duplicates, newProducts: parsed.rows.filter((row) => !existingIds.has(row.identity)).length, existingProducts: parsed.rows.filter((row) => existingIds.has(row.identity)).length, newOffers: parsed.rows.filter((row) => !identitiesWithOffers.has(row.identity)).length, updatableOffers: parsed.rows.filter((row) => identitiesWithOffers.has(row.identity)).length, ignoredRows: parsed.issues.length, errorsByCode: Object.fromEntries([...new Set(parsed.issues.map((issue) => issue.code))].map((code) => [code, parsed.issues.filter((issue) => issue.code === code).length])) } };
}

export type ShopeeImportDependencies = {
  database: typeof prisma;
  acquire: typeof acquireLock;
  inspect: typeof inspectShopeeCsv;
  ingest: typeof ingestOfferInTransaction;
};

const defaultImportDependencies: ShopeeImportDependencies = {
  database: prisma,
  acquire: acquireLock,
  inspect: inspectShopeeCsv,
  ingest: ingestOfferInTransaction,
};

export async function importShopeeCsv(
  input: { file: string; confirm: boolean; dryRun: boolean },
  overrides: Partial<ShopeeImportDependencies> = {},
) {
  const dependencies = { ...defaultImportDependencies, ...overrides };
  const status = shopeeAffiliateStatus();
  if (status.mode !== "CSV") throw new Error("SHOPEE_CSV_MODE_REQUIRED");
  const inspected = await dependencies.inspect(input.file, dependencies.database);
  if (!input.confirm || input.dryRun) return { event: "SHOPEE_IMPORT_DRY_RUN_COMPLETED", status: "DRY_RUN", checksum: inspected.checksum, ...inspected.summary, databaseWrites: 0 };
  const lock = await dependencies.acquire("shopee:affiliate:csv-import", 120_000, { requireRedis: true });
  if (!lock.acquired) throw new Error("SHOPEE_IMPORT_ALREADY_RUNNING");
  try {
    const source = `SHOPEE_AFFILIATE_CSV:${inspected.checksum}`;
    const duplicate = await dependencies.database.importJob.findFirst({ where: { marketplace: "SHOPEE", source, status: { in: ["SUCCEEDED", "SUCCEEDED_WITH_ERRORS"] } }, select: { id: true, summary: true } });
    if (duplicate) {
      const previousSummary = record(duplicate.summary);
      await dependencies.database.importJob.update({
        where: { id: duplicate.id },
        data: {
          summary: {
            ...previousSummary,
            lastDuplicateAt: new Date().toISOString(),
            duplicateAttempts: typeof previousSummary.duplicateAttempts === "number"
              ? previousSummary.duplicateAttempts + 1
              : 1,
          },
        },
      });
      return { event: "SHOPEE_IMPORT_INSPECTED", status: "DUPLICATE_FILE", importJobId: duplicate.id, checksum: inspected.checksum, databaseWrites: 1 };
    }
    const job = await dependencies.database.importJob.create({ data: { marketplace: "SHOPEE", source, status: "RUNNING", startedAt: new Date(), totalFound: inspected.summary.totalRows, summary: { checksum: inspected.checksum, mode: "CSV" } } });
    try {
      const results = await dependencies.database.$transaction(async (tx) => {
        const output = [];
        for (const issue of inspected.issues) {
          await tx.importJobItem.create({
            data: {
              importJobId: job.id,
              sourceType: "SHOPEE_AFFILIATE_CSV",
              stage: "INGESTION",
              status: "FAILED",
              errorCode: issue.code,
              metadata: { line: issue.line, phase: "CSV_VALIDATION" },
            },
          });
        }
        for (const row of inspected.rows) {
          const result = await dependencies.ingest(tx, { marketplace: "SHOPEE", externalProductId: row.identity, title: row.title, category: row.category ?? undefined, imageUrl: row.imageUrl ?? undefined, productUrl: row.productUrl, affiliateUrl: row.affiliateUrl ?? undefined, affiliateLabel: "Shopee Affiliate CSV", affiliateEligibility: row.affiliateUrl ? "ELIGIBLE" : "UNKNOWN", sellerId: row.shopId ?? undefined, officialStoreId: row.shopId ?? undefined, trackingStrategy: row.affiliateUrl ? "DIRECT_AFFILIATE_LINK" : "INTERNAL_REDIRECT", originalPrice: row.originalPrice ?? undefined, currentPrice: row.currentPrice, commissionPercentage: row.commissionPercentage ?? undefined, shippingStatus: "UNKNOWN", stockStatus: "UNKNOWN" }, { now: new Date(), minScore: 70 });
          await tx.importJobItem.create({ data: { importJobId: job.id, sourceId: row.identity, sourceType: "SHOPEE_AFFILIATE_CSV", externalItemId: row.productId, productId: result.productId ?? null, offerId: result.offerId ?? null, stage: "INGESTION", status: result.ok ? "SUCCEEDED" : "FAILED", errorCode: result.ok ? null : "INGESTION_REJECTED", metadata: { line: row.line, shopIdConfigured: Boolean(row.shopId), affiliateLinkProvided: Boolean(row.affiliateUrl), commission: row.commission, currency: row.currency, seller: row.seller, availability: row.availability, validUntil: row.validUntil, sourceTimestamp: row.sourceTimestamp } } });
          output.push(result);
        }
        const created = output.filter((item) => item.offerCreated).length;
        const updated = output.filter((item) => item.offerUpdated).length;
        const failed = output.filter((item) => !item.ok).length + inspected.issues.length;
        await tx.importJob.update({ where: { id: job.id }, data: { status: failed ? "SUCCEEDED_WITH_ERRORS" : "SUCCEEDED", finishedAt: new Date(), totalResolved: output.length, totalCreated: created, totalUpdated: updated, totalFailed: failed, totalReadyToPublish: output.filter((item) => item.status === "READY_TO_PUBLISH").length, totalReadyForAffiliateLink: output.filter((item) => item.status === "READY_FOR_AFFILIATE_LINK").length, summary: { checksum: inspected.checksum, mode: "CSV", invalidRows: inspected.issues.length } } });
        return { created, updated, failed };
      });
      return { event: "SHOPEE_IMPORT_SUCCEEDED", status: results.failed ? "SUCCEEDED_WITH_ERRORS" : "SUCCEEDED", importJobId: job.id, checksum: inspected.checksum, ...results };
    } catch (error) {
      await dependencies.database.importJob.update({ where: { id: job.id }, data: { status: "FAILED", finishedAt: new Date(), totalFailed: inspected.rows.length, errorMessage: "SHOPEE_IMPORT_TRANSACTION_FAILED" } });
      throw error;
    }
  } finally { await lock.release(); }
}

export function shopeeOpenApiPreflight(env: NodeJS.ProcessEnv = process.env) {
  const status = shopeeAffiliateStatus(env);
  return {
    event: "SHOPEE_API_PREFLIGHT",
    ...status,
    ready: false,
    documentationConfirmed: false,
    baseUrlConfirmed: false,
    authenticationConfirmed: false,
    endpointsConfirmed: false,
    blockers: [
      ...(!status.credentialsConfigured ? ["CREDENTIALS_NOT_CONFIGURED"] : []),
      "OFFICIAL_DOCUMENTATION_NOT_CONFIRMED",
      "BASE_URL_NOT_CONFIRMED",
      "AUTHENTICATION_NOT_CONFIRMED",
      "ENDPOINTS_NOT_CONFIRMED",
    ],
  };
}
