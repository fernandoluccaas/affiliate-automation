import { createHash } from "node:crypto";
import { parseAttributionSubId } from "./sub-id";

export type FinancialImportType = "CONVERSION" | "COMMISSION";
export type FinancialCsvMarketplace = "MERCADO_LIVRE" | "SHOPEE";
export type FinancialCsvIssue = { line: number; code: string };

export type CanonicalConversionRow = {
  line: number;
  externalEventId: string;
  externalOrderId: string | null;
  externalItemId: string | null;
  occurredAt: Date;
  amount: number;
  currency: string;
  clickReference: string | null;
  subId: string | null;
  affiliateSlug: string | null;
  publicationReference: string | null;
  offerReference: string | null;
  attributionWindowHours: number | null;
};

export type CanonicalCommissionRow = {
  line: number;
  externalEventId: string;
  externalOrderId: string | null;
  externalItemId: string | null;
  occurredAt: Date;
  amount: number;
  currency: string;
  percentage: number | null;
  status: "PENDING" | "APPROVED" | "CANCELLED" | "REVERSED" | "ADJUSTED";
  conversionExternalEventId: string | null;
  affiliateSlug: string | null;
};

type ColumnName =
  | "externalEventId"
  | "externalOrderId"
  | "externalItemId"
  | "occurredAt"
  | "amount"
  | "currency"
  | "clickReference"
  | "subId"
  | "affiliateSlug"
  | "publicationReference"
  | "offerReference"
  | "attributionWindowHours"
  | "percentage"
  | "status"
  | "conversionExternalEventId";

export const FINANCIAL_CSV_ALIASES: Record<ColumnName, readonly string[]> = {
  externalEventId: ["external event id", "event id", "id do evento"],
  externalOrderId: ["external order id", "order id", "id do pedido"],
  externalItemId: ["external item id", "item id", "id do item"],
  occurredAt: ["occurred at", "event date", "data do evento"],
  amount: ["amount", "valor"],
  currency: ["currency", "moeda"],
  clickReference: ["click reference", "referencia do clique"],
  subId: ["sub id", "subid"],
  affiliateSlug: ["affiliate slug", "slug afiliado"],
  publicationReference: ["publication reference", "referencia da publicacao"],
  offerReference: ["offer reference", "referencia da oferta"],
  attributionWindowHours: ["attribution window hours", "janela de atribuicao horas"],
  percentage: ["percentage", "percentual"],
  status: ["status"],
  conversionExternalEventId: ["conversion external event id", "id do evento de conversao"],
};

function key(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function delimiterCounts(value: string) {
  let comma = 0;
  let semicolon = 0;
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '"') quoted = !quoted;
    else if (!quoted && character === ",") comma += 1;
    else if (!quoted && character === ";") semicolon += 1;
    else if (!quoted && (character === "\n" || character === "\r")) break;
  }
  return { comma, semicolon };
}

function csvRows(text: string, delimiter: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (character === delimiter && !quoted) {
      row.push(cell.trim());
      cell = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  return { rows, unclosedQuote: quoted };
}

function parseDecimal(value: string, brazilian: boolean) {
  const trimmed = value.trim().replace(/\s/g, "");
  if (!trimmed) return null;
  const normalized = brazilian
    ? trimmed.replace(/\./g, "").replace(",", ".")
    : trimmed;
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function validCalendarDate(year: number, month: number, day: number) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function parseDate(value: string, dateFormat: "ISO" | "BR") {
  if (dateFormat === "BR") {
    const match = /^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(value.trim());
    if (!match) return null;
    const year = Number(match[3]);
    const month = Number(match[2]);
    const day = Number(match[1]);
    const hour = Number(match[4] ?? "00");
    const minute = Number(match[5] ?? "00");
    const second = Number(match[6] ?? "00");
    if (!validCalendarDate(year, month, day) || hour > 23 || minute > 59 || second > 59) return null;
    const iso = `${match[3]}-${match[2]}-${match[1]}T${match[4] ?? "00"}:${match[5] ?? "00"}:${match[6] ?? "00"}-03:00`;
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value.trim());
  if (!match) return null;
  if (!validCalendarDate(Number(match[1]), Number(match[2]), Number(match[3])) || Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59) return null;
  const date = new Date(value.trim());
  return Number.isNaN(date.getTime()) ? null : date;
}

function dangerousFormula(value: string) {
  const trimmed = value.trim();
  if (/^-\d+(?:[.,]\d+)?$/.test(trimmed)) return false;
  return /^[=+@-]/.test(trimmed);
}

function optional(value: string) {
  return value.trim() || null;
}

export function financialAdapterStatus(marketplace: FinancialCsvMarketplace) {
  return marketplace === "SHOPEE"
    ? { state: "WAITING_FOR_OFFICIAL_REPORT", adapterVersion: null, compatibleWithOfficialReport: false }
    : { state: "CANONICAL_FIXTURE_ONLY", adapterVersion: "canonical-v1", compatibleWithOfficialReport: false };
}

export function parseFinancialCsv(
  input: Buffer | string,
  type: FinancialImportType,
  options: {
    marketplace: FinancialCsvMarketplace;
    dateFormat?: "ISO" | "BR";
    decimalFormat?: "DOT" | "BR";
    maxBytes?: number;
    maxRows?: number;
    subIdSecret?: string;
  },
) {
  const buffer = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  const checksum = createHash("sha256").update(buffer).digest("hex");
  const maxBytes = options.maxBytes ?? 5_000_000;
  const maxRows = options.maxRows ?? 10_000;
  if (buffer.byteLength > maxBytes) return { checksum, columns: [], rows: [], issues: [{ line: 0, code: "FILE_TOO_LARGE" }], duplicates: 0 };
  const adapter = financialAdapterStatus(options.marketplace);
  if (adapter.state === "WAITING_FOR_OFFICIAL_REPORT") return { checksum, columns: [], rows: [], issues: [{ line: 0, code: "SHOPEE_OFFICIAL_REPORT_NOT_CONFIRMED" }], duplicates: 0 };
  const text = buffer.toString("utf8").replace(/^\uFEFF/, "");
  if (!text.trim()) return { checksum, columns: [], rows: [], issues: [{ line: 0, code: "EMPTY_FILE" }], duplicates: 0 };
  const counts = delimiterCounts(text);
  if (counts.comma === counts.semicolon) return { checksum, columns: [], rows: [], issues: [{ line: 1, code: "AMBIGUOUS_DELIMITER" }], duplicates: 0 };
  const delimiter = counts.semicolon > counts.comma ? ";" : ",";
  const parsed = csvRows(text, delimiter);
  if (parsed.unclosedQuote) return { checksum, columns: [], rows: [], issues: [{ line: 0, code: "UNCLOSED_QUOTE" }], duplicates: 0 };
  const [header = [], ...data] = parsed.rows;
  if (data.length > maxRows) return { checksum, columns: header, rows: [], issues: [{ line: 0, code: "ROW_LIMIT_EXCEEDED" }], duplicates: 0 };
  const normalizedHeaders = header.map(key);
  if (new Set(normalizedHeaders).size !== normalizedHeaders.length) return { checksum, columns: header, rows: [], issues: [{ line: 1, code: "DUPLICATE_COLUMN" }], duplicates: 0 };
  const indexes = {} as Record<ColumnName, number>;
  const ambiguous: ColumnName[] = [];
  for (const [name, aliases] of Object.entries(FINANCIAL_CSV_ALIASES) as Array<[ColumnName, readonly string[]]>) {
    const normalizedAliases = new Set(aliases.map(key));
    const matches = normalizedHeaders.flatMap((value, index) => normalizedAliases.has(value) ? [index] : []);
    indexes[name] = matches[0] ?? -1;
    if (matches.length > 1) ambiguous.push(name);
  }
  if (ambiguous.length) return { checksum, columns: header, rows: [], issues: ambiguous.map((name) => ({ line: 1, code: `AMBIGUOUS_HEADER_${name.toUpperCase()}` })), duplicates: 0 };
  const required: ColumnName[] = type === "CONVERSION"
    ? ["externalEventId", "occurredAt", "amount", "currency"]
    : ["externalEventId", "occurredAt", "amount", "currency", "status"];
  const missing = required.filter((name) => indexes[name] < 0);
  if (missing.length) return { checksum, columns: header, rows: [], issues: missing.map((name) => ({ line: 1, code: `MISSING_COLUMN_${name.toUpperCase()}` })), duplicates: 0 };
  const issues: FinancialCsvIssue[] = [];
  const rows: Array<CanonicalConversionRow | CanonicalCommissionRow> = [];
  const seen = new Set<string>();
  let duplicates = 0;
  const get = (values: string[], name: ColumnName) => indexes[name] >= 0 ? values[indexes[name]!]?.trim() ?? "" : "";
  for (let offset = 0; offset < data.length; offset += 1) {
    const values = data[offset]!;
    const line = offset + 2;
    if (values.some(dangerousFormula)) { issues.push({ line, code: "DANGEROUS_FORMULA" }); continue; }
    const externalEventId = get(values, "externalEventId");
    if (!externalEventId || externalEventId.length > 160) { issues.push({ line, code: "EXTERNAL_EVENT_ID_REQUIRED" }); continue; }
    if (seen.has(externalEventId)) { duplicates += 1; issues.push({ line, code: "DUPLICATE_EVENT" }); continue; }
    seen.add(externalEventId);
    const occurredAt = parseDate(get(values, "occurredAt"), options.dateFormat ?? "ISO");
    if (!occurredAt) { issues.push({ line, code: "INVALID_DATE" }); continue; }
    const amount = parseDecimal(get(values, "amount"), options.decimalFormat === "BR");
    if (amount === null || amount < 0 || amount > 9_999_999_999.99) { issues.push({ line, code: "INVALID_AMOUNT" }); continue; }
    const currency = get(values, "currency").toUpperCase();
    if (!["BRL", "USD", "EUR"].includes(currency)) { issues.push({ line, code: "INVALID_CURRENCY" }); continue; }
    const affiliateSlug = optional(get(values, "affiliateSlug"));
    if (affiliateSlug && !/^[a-z0-9][a-z0-9-]{0,99}$/i.test(affiliateSlug)) { issues.push({ line, code: "INVALID_AFFILIATE_SLUG" }); continue; }
    const common = {
      line,
      externalEventId,
      externalOrderId: optional(get(values, "externalOrderId")),
      externalItemId: optional(get(values, "externalItemId")),
      occurredAt,
      amount,
      currency,
      affiliateSlug,
    };
    if (type === "CONVERSION") {
      const subId = optional(get(values, "subId"));
      if (subId && !options.subIdSecret) { issues.push({ line, code: "SUB_ID_SECRET_NOT_CONFIGURED" }); continue; }
      if (subId && !parseAttributionSubId(subId, options.subIdSecret!).ok) { issues.push({ line, code: "INVALID_SUB_ID" }); continue; }
      const windowRaw = get(values, "attributionWindowHours");
      const window = windowRaw ? Number(windowRaw) : null;
      if (window !== null && (!Number.isSafeInteger(window) || window <= 0 || window > 8_760)) { issues.push({ line, code: "INVALID_ATTRIBUTION_WINDOW" }); continue; }
      rows.push({
        ...common,
        clickReference: optional(get(values, "clickReference")),
        subId,
        publicationReference: optional(get(values, "publicationReference")),
        offerReference: optional(get(values, "offerReference")),
        attributionWindowHours: window,
      });
    } else {
      const status = get(values, "status").toUpperCase();
      if (!["PENDING", "APPROVED", "CANCELLED", "REVERSED", "ADJUSTED"].includes(status)) { issues.push({ line, code: "INVALID_COMMISSION_STATUS" }); continue; }
      const percentageRaw = get(values, "percentage");
      const percentage = percentageRaw ? parseDecimal(percentageRaw, options.decimalFormat === "BR") : null;
      if (percentage !== null && (percentage < 0 || percentage > 100)) { issues.push({ line, code: "INVALID_PERCENTAGE" }); continue; }
      rows.push({
        ...common,
        percentage,
        status: status as CanonicalCommissionRow["status"],
        conversionExternalEventId: optional(get(values, "conversionExternalEventId")),
      });
    }
  }
  return { checksum, delimiter, columns: header, rows, issues, duplicates };
}
