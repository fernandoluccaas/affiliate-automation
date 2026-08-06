import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { financialAdapterStatus, parseFinancialCsv } from "./csv";
import { createAttributionSubId } from "./sub-id";

const header = "externalEventId,occurredAt,amount,currency,affiliateSlug";
const valid = `${header}\nfixture-event-001,2026-08-05T12:00:00-03:00,19.90,BRL,fixture-link`;

describe("canonical financial CSV parser", () => {
  it("parses comma-separated UTF-8 with Portuguese quoted content", () => {
    const result = parseFinancialCsv(`${header}\nfixture-ação-001,2026-08-05T12:00:00Z,"19.90",BRL,fixture-link`, "CONVERSION", { marketplace: "MERCADO_LIVRE" });
    expect(result).toMatchObject({ delimiter: ",", duplicates: 0 });
    expect(result.rows[0]).toMatchObject({ externalEventId: "fixture-ação-001", amount: 19.9, currency: "BRL" });
  });

  it("removes a UTF-8 BOM", () => {
    expect(parseFinancialCsv(`\uFEFF${valid}`, "CONVERSION", { marketplace: "MERCADO_LIVRE" }).rows).toHaveLength(1);
  });

  it("parses semicolon CSV, Brazilian date and decimal only when configured", () => {
    const csv = "id do evento;data do evento;valor;moeda\nfixture-event-002;05/08/2026 12:30:00;1.234,56;BRL";
    const result = parseFinancialCsv(csv, "CONVERSION", { marketplace: "MERCADO_LIVRE", dateFormat: "BR", decimalFormat: "BR" });
    expect(result).toMatchObject({ delimiter: ";" });
    expect(result.rows[0]).toMatchObject({ amount: 1234.56 });
    expect(result.rows[0]?.occurredAt.toISOString()).toBe("2026-08-05T15:30:00.000Z");
  });

  it("supports quoted delimiters and escaped quotes deterministically", () => {
    const csv = `${header}\n"fixture,event-003",2026-08-05T12:00:00Z,10.00,BRL,"fixture-link"`;
    expect(parseFinancialCsv(csv, "CONVERSION", { marketplace: "MERCADO_LIVRE" }).rows[0]).toMatchObject({ externalEventId: "fixture,event-003" });
  });

  it.each([
    ["", "EMPTY_FILE"],
    ["externalEventId,occurredAt,amount\nfixture,2026-08-05T12:00:00Z,1.00", "MISSING_COLUMN_CURRENCY"],
    ["externalEventId,externalEventId,occurredAt,amount,currency\na,b,2026-08-05T12:00:00Z,1.00,BRL", "DUPLICATE_COLUMN"],
    ["externalEventId,event id,occurredAt,amount,currency\na,b,2026-08-05T12:00:00Z,1.00,BRL", "AMBIGUOUS_HEADER_EXTERNALEVENTID"],
  ])("rejects invalid file structure", (csv, code) => {
    expect(parseFinancialCsv(csv, "CONVERSION", { marketplace: "MERCADO_LIVRE" }).issues).toContainEqual(expect.objectContaining({ code }));
  });

  it.each([
    ["fixture,not-a-date,10.00,BRL,fixture-link", "INVALID_DATE"],
    ["fixture,2026-02-31T12:00:00Z,10.00,BRL,fixture-link", "INVALID_DATE"],
    ["fixture,2026-08-05T12:00:00Z,invalid,BRL,fixture-link", "INVALID_AMOUNT"],
    ["fixture,2026-08-05T12:00:00Z,-1.00,BRL,fixture-link", "INVALID_AMOUNT"],
    ["fixture,2026-08-05T12:00:00Z,10.00,XYZ,fixture-link", "INVALID_CURRENCY"],
    ["fixture,2026-08-05T12:00:00Z,10.00,BRL,../private", "INVALID_AFFILIATE_SLUG"],
    ["=FORMULA,2026-08-05T12:00:00Z,10.00,BRL,fixture-link", "DANGEROUS_FORMULA"],
    [",2026-08-05T12:00:00Z,10.00,BRL,fixture-link", "EXTERNAL_EVENT_ID_REQUIRED"],
  ])("returns a sanitized error for an invalid row", (row, code) => {
    expect(parseFinancialCsv(`${header}\n${row}`, "CONVERSION", { marketplace: "MERCADO_LIVRE" }).issues).toContainEqual({ line: 2, code });
  });

  it("detects duplicate events inside a file", () => {
    const result = parseFinancialCsv(`${valid}\nfixture-event-001,2026-08-05T12:01:00Z,20.00,BRL,fixture-link`, "CONVERSION", { marketplace: "MERCADO_LIVRE" });
    expect(result.duplicates).toBe(1);
    expect(result.issues).toContainEqual({ line: 3, code: "DUPLICATE_EVENT" });
  });

  it("validates versioned Sub IDs with the dedicated secret", () => {
    const subIdSecret = "test-sub-id-secret-with-at-least-32-characters";
    const subId = createAttributionSubId({ secret: subIdSecret, marketplace: "MERCADO_LIVRE", channelId: "channel", publicationId: "publication" });
    const csv = `externalEventId,occurredAt,amount,currency,subId\nfixture-subid,2026-08-05T12:00:00Z,10.00,BRL,${subId}`;
    expect(parseFinancialCsv(csv, "CONVERSION", { marketplace: "MERCADO_LIVRE", subIdSecret }).rows).toHaveLength(1);
    expect(parseFinancialCsv(csv.replace(subId, "invalid"), "CONVERSION", { marketplace: "MERCADO_LIVRE", subIdSecret }).issues[0]).toMatchObject({ code: "INVALID_SUB_ID" });
    expect(parseFinancialCsv(csv, "CONVERSION", { marketplace: "MERCADO_LIVRE" }).issues[0]).toMatchObject({ code: "SUB_ID_SECRET_NOT_CONFIGURED" });
  });

  it("validates commission status and percentage", () => {
    const commissionHeader = "externalEventId,occurredAt,amount,currency,percentage,status";
    expect(parseFinancialCsv(`${commissionHeader}\ncommission-1,2026-08-05T12:00:00Z,1.00,BRL,8.5,APPROVED`, "COMMISSION", { marketplace: "MERCADO_LIVRE" }).rows[0]).toMatchObject({ status: "APPROVED", percentage: 8.5 });
    expect(parseFinancialCsv(`${commissionHeader}\ncommission-2,2026-08-05T12:00:00Z,1.00,BRL,8.5,UNKNOWN`, "COMMISSION", { marketplace: "MERCADO_LIVRE" }).issues[0]).toMatchObject({ code: "INVALID_COMMISSION_STATUS" });
  });

  it("enforces byte and row limits", () => {
    expect(parseFinancialCsv(valid, "CONVERSION", { marketplace: "MERCADO_LIVRE", maxBytes: 10 }).issues[0]).toMatchObject({ code: "FILE_TOO_LARGE" });
    expect(parseFinancialCsv(`${valid}\nfixture-event-2,2026-08-05T12:00:00Z,1.00,BRL,fixture-link`, "CONVERSION", { marketplace: "MERCADO_LIVRE", maxRows: 1 }).issues[0]).toMatchObject({ code: "ROW_LIMIT_EXCEEDED" });
  });

  it("calculates a stable SHA-256 checksum", () => {
    const first = parseFinancialCsv(valid, "CONVERSION", { marketplace: "MERCADO_LIVRE" });
    expect(first.checksum).toBe(parseFinancialCsv(valid, "CONVERSION", { marketplace: "MERCADO_LIVRE" }).checksum);
    expect(first.checksum).toMatch(/^[a-f0-9]{64}$/);
  });

  it("parses all sanitized Mercado Livre and generic fixtures", async () => {
    const fixtureRoot = resolve(process.cwd(), "fixtures");
    const conversion = await readFile(resolve(fixtureRoot, "mercado-livre-conversions-sanitized.csv"));
    const commission = await readFile(resolve(fixtureRoot, "mercado-livre-commissions-sanitized.csv"));
    const generic = await readFile(resolve(fixtureRoot, "generic-conversions-sanitized.csv"));
    expect(parseFinancialCsv(conversion, "CONVERSION", { marketplace: "MERCADO_LIVRE" }).rows).toHaveLength(2);
    expect(parseFinancialCsv(commission, "COMMISSION", { marketplace: "MERCADO_LIVRE" }).rows).toHaveLength(2);
    expect(parseFinancialCsv(generic, "CONVERSION", { marketplace: "MERCADO_LIVRE", dateFormat: "BR", decimalFormat: "BR" }).rows).toHaveLength(1);
  });

  it("keeps Shopee fail-closed until an official report contract is confirmed", () => {
    expect(financialAdapterStatus("SHOPEE")).toMatchObject({ state: "WAITING_FOR_OFFICIAL_REPORT", compatibleWithOfficialReport: false });
    expect(parseFinancialCsv(valid, "CONVERSION", { marketplace: "SHOPEE" }).issues[0]).toMatchObject({ code: "SHOPEE_OFFICIAL_REPORT_NOT_CONFIRMED" });
  });
});
