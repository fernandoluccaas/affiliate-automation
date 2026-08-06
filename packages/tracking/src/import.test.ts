import { describe, expect, it, vi } from "vitest";
import { attributionConfiguration, attributionPreflight, importFinancialCsv, inspectFinancialCsv } from "./import";

const row = {
  line: 2,
  externalEventId: "fixture-event-001",
  externalOrderId: "fixture-order-001",
  externalItemId: "fixture-item-001",
  occurredAt: new Date("2026-08-05T12:00:00Z"),
  amount: 10,
  currency: "BRL",
  clickReference: null,
  subId: null,
  affiliateSlug: null,
  publicationReference: null,
  offerReference: null,
  attributionWindowHours: 168,
};

const decision = {
  status: "UNATTRIBUTED_NO_CLICK",
  method: "NONE",
  matchQuality: "NONE",
  attributedAt: null,
  attributionWindowHours: 168,
  clickId: null,
  affiliateLinkId: null,
  publicationId: null,
  offerId: null,
  channelId: null,
  metadata: {
    reason: "NO_ELIGIBLE_CLICK",
    candidatesConsidered: 0,
    explicitClickReferenceUsed: false,
    subIdUsed: false,
    affiliateLinkUsed: false,
    publicationUsed: false,
    offerUsed: false,
  },
};

function inspected(overrides: Record<string, unknown> = {}) {
  return {
    checksum: "a".repeat(64),
    delimiter: ",",
    columns: ["externalEventId"],
    rows: [row],
    issues: [],
    duplicates: 0,
    adapter: { state: "CANONICAL_FIXTURE_ONLY", adapterVersion: "canonical-v1", compatibleWithOfficialReport: false },
    summary: { totalRows: 1, validRows: 1, invalidRows: 0, duplicateRows: 0, existingEvents: 0, newEvents: 1, attributed: 0, unattributed: 1, ambiguous: 0, orphanCommissions: 0, errorsByCode: {} },
    existingIds: new Set<string>(),
    attributionDecisions: new Map([[row.externalEventId, decision]]),
    ...overrides,
  };
}

function lock(overrides: Record<string, unknown> = {}) {
  return {
    acquired: true,
    extend: vi.fn().mockResolvedValue(true),
    release: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const input = {
  file: "fixture.csv",
  marketplace: "MERCADO_LIVRE" as const,
  type: "CONVERSION" as const,
};

describe("financial import safety and idempotency", () => {
  it("rejects nonexistent files and traversal before database access", async () => {
    await expect(inspectFinancialCsv({ ...input, file: "does-not-exist.csv" }, {} as never)).rejects.toThrow("FINANCIAL_CSV_NOT_FILE");
    await expect(inspectFinancialCsv({ ...input, file: "../private.csv" }, {} as never)).rejects.toThrow("FINANCIAL_CSV_PATH_INVALID");
  });

  it("requires exactly one explicit execution mode before any write", async () => {
    const inspect = vi.fn();
    await expect(importFinancialCsv({ ...input, dryRun: false, confirmImport: false }, { inspect: inspect as never })).rejects.toThrow("CHOOSE_EXACTLY_ONE");
    await expect(importFinancialCsv({ ...input, dryRun: true, confirmImport: true }, { inspect: inspect as never })).rejects.toThrow("CHOOSE_EXACTLY_ONE");
    expect(inspect).not.toHaveBeenCalled();
  });

  it("dry-run performs zero database and Redis writes", async () => {
    const database = { importJob: { create: vi.fn() }, conversion: { create: vi.fn() } };
    const acquire = vi.fn();
    const result = await importFinancialCsv(
      { ...input, dryRun: true, confirmImport: false },
      { database: database as never, acquire: acquire as never, inspect: vi.fn().mockResolvedValue(inspected()) as never },
    );
    expect(result).toMatchObject({ status: "DRY_RUN", databaseWrites: 0, unattributed: 1 });
    expect(database.importJob.create).not.toHaveBeenCalled();
    expect(database.conversion.create).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
  });

  it("confirmed import is disabled by default", async () => {
    await expect(importFinancialCsv(
      { ...input, dryRun: false, confirmImport: true },
      { database: {} as never, inspect: vi.fn().mockResolvedValue(inspected()) as never },
      {},
    )).rejects.toThrow("CONFIRMED_FINANCIAL_IMPORTS_DISABLED");
  });

  it("fails before writing when Redis cannot acquire the file lock", async () => {
    const database = { importJob: { create: vi.fn() } };
    await expect(importFinancialCsv(
      { ...input, dryRun: false, confirmImport: true },
      { database: database as never, inspect: vi.fn().mockResolvedValue(inspected()) as never, acquire: vi.fn().mockResolvedValue({ acquired: false }) as never },
      { ATTRIBUTION_IMPORT_ENABLED: "true" },
    )).rejects.toThrow("FINANCIAL_IMPORT_FILE_LOCK_UNAVAILABLE");
    expect(database.importJob.create).not.toHaveBeenCalled();
  });

  it("detects an already imported file without duplicating events", async () => {
    const fileLock = lock();
    const typeLock = lock();
    const database = {
      importJob: {
        findFirst: vi.fn().mockResolvedValue({ id: "original-job" }),
        create: vi.fn().mockResolvedValue({ id: "duplicate-job" }),
      },
    };
    const result = await importFinancialCsv(
      { ...input, dryRun: false, confirmImport: true },
      { database: database as never, inspect: vi.fn().mockResolvedValue(inspected()) as never, acquire: vi.fn().mockResolvedValueOnce(fileLock).mockResolvedValueOnce(typeLock) as never },
      { ATTRIBUTION_IMPORT_ENABLED: "true" },
    );
    expect(result).toMatchObject({ status: "DUPLICATE", created: 0, skipped: 1 });
    expect(database.importJob.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "DUPLICATE" }) }));
    expect(fileLock.release).toHaveBeenCalledOnce();
    expect(typeLock.release).toHaveBeenCalledOnce();
  });

  it("persists a confirmed conversion and its audit item in one transaction", async () => {
    const fileLock = lock();
    const typeLock = lock();
    const transaction = {
      conversion: { create: vi.fn().mockResolvedValue({ id: "conversion-1" }) },
      importJobItem: { create: vi.fn().mockResolvedValue({}) },
      importJob: { update: vi.fn().mockResolvedValue({}) },
    };
    const database = {
      importJob: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: "job-1" }),
        update: vi.fn(),
      },
      $transaction: vi.fn((callback) => callback(transaction)),
    };
    const result = await importFinancialCsv(
      { ...input, dryRun: false, confirmImport: true },
      { database: database as never, inspect: vi.fn().mockResolvedValue(inspected()) as never, acquire: vi.fn().mockResolvedValueOnce(fileLock).mockResolvedValueOnce(typeLock) as never },
      { ATTRIBUTION_IMPORT_ENABLED: "true" },
    );
    expect(result).toMatchObject({ status: "SUCCEEDED", created: 1, failed: 0 });
    expect(transaction.conversion.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ externalEventId: row.externalEventId, currency: "BRL", attributionStatus: "UNATTRIBUTED_NO_CLICK" }) }));
    expect(transaction.importJobItem.create).toHaveBeenCalled();
  });

  it("persists an orphan commission explicitly without inventing attribution", async () => {
    const fileLock = lock();
    const typeLock = lock();
    const commissionRow = {
      line: 2,
      externalEventId: "fixture-commission-001",
      externalOrderId: "fixture-order-001",
      externalItemId: "fixture-item-001",
      occurredAt: new Date("2026-08-05T12:00:00Z"),
      amount: 2,
      currency: "BRL",
      percentage: 10,
      status: "PENDING",
      conversionExternalEventId: "missing-conversion",
      affiliateSlug: null,
    };
    const transaction = {
      conversion: { findUnique: vi.fn().mockResolvedValue(null) },
      commission: { create: vi.fn().mockResolvedValue({ id: "commission-1" }) },
      importJobItem: { create: vi.fn().mockResolvedValue({}) },
      importJob: { update: vi.fn().mockResolvedValue({}) },
    };
    const database = {
      importJob: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: "job-1" }), update: vi.fn() },
      $transaction: vi.fn((callback) => callback(transaction)),
    };
    const commissionInspection = inspected({
      rows: [commissionRow],
      summary: { ...inspected().summary, unattributed: 0, orphanCommissions: 1 },
      attributionDecisions: new Map(),
    });
    const result = await importFinancialCsv(
      { file: "fixture.csv", marketplace: "MERCADO_LIVRE", type: "COMMISSION", dryRun: false, confirmImport: true },
      { database: database as never, inspect: vi.fn().mockResolvedValue(commissionInspection) as never, acquire: vi.fn().mockResolvedValueOnce(fileLock).mockResolvedValueOnce(typeLock) as never },
      { ATTRIBUTION_IMPORT_ENABLED: "true" },
    );
    expect(result).toMatchObject({ status: "SUCCEEDED", created: 1 });
    expect(transaction.commission.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ conversionId: null, offerId: null, currency: "BRL", metadata: { orphan: true, source: "CANONICAL_CSV_V1" } }) }));
  });

  it("supports partial import with sanitized row failures", async () => {
    const fileLock = lock();
    const typeLock = lock();
    const transaction = {
      conversion: { create: vi.fn().mockResolvedValue({ id: "conversion-1" }) },
      importJobItem: { create: vi.fn().mockResolvedValue({}) },
      importJob: { update: vi.fn().mockResolvedValue({}) },
    };
    const database = {
      importJob: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: "job-1" }), update: vi.fn() },
      $transaction: vi.fn((callback) => callback(transaction)),
    };
    const result = await importFinancialCsv(
      { ...input, dryRun: false, confirmImport: true },
      { database: database as never, inspect: vi.fn().mockResolvedValue(inspected({ issues: [{ line: 3, code: "INVALID_CURRENCY" }], summary: { ...inspected().summary, totalRows: 2, invalidRows: 1 } })) as never, acquire: vi.fn().mockResolvedValueOnce(fileLock).mockResolvedValueOnce(typeLock) as never },
      { ATTRIBUTION_IMPORT_ENABLED: "true" },
    );
    expect(result).toMatchObject({ status: "SUCCEEDED_WITH_ERRORS", created: 1, failed: 1 });
    expect(transaction.importJobItem.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ errorCode: "INVALID_CURRENCY", metadata: { line: 3 } }) }));
  });

  it("skips an event already imported by a different file", async () => {
    const fileLock = lock();
    const typeLock = lock();
    const transaction = {
      conversion: { create: vi.fn() },
      importJobItem: { create: vi.fn().mockResolvedValue({}) },
      importJob: { update: vi.fn().mockResolvedValue({}) },
    };
    const database = {
      importJob: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: "job-1" }), update: vi.fn() },
      $transaction: vi.fn((callback) => callback(transaction)),
    };
    const result = await importFinancialCsv(
      { ...input, dryRun: false, confirmImport: true },
      { database: database as never, inspect: vi.fn().mockResolvedValue(inspected({ existingIds: new Set([row.externalEventId]), summary: { ...inspected().summary, existingEvents: 1, newEvents: 0 } })) as never, acquire: vi.fn().mockResolvedValueOnce(fileLock).mockResolvedValueOnce(typeLock) as never },
      { ATTRIBUTION_IMPORT_ENABLED: "true" },
    );
    expect(result).toMatchObject({ created: 0, skipped: 1 });
    expect(transaction.conversion.create).not.toHaveBeenCalled();
    expect(transaction.importJobItem.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "SKIPPED", errorCode: "DUPLICATE_EVENT" }) }));
  });

  it("rolls business writes back and leaves a sanitized failed job", async () => {
    const fileLock = lock();
    const typeLock = lock();
    const update = vi.fn().mockResolvedValue({});
    const database = {
      importJob: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: "job-1" }), update },
      $transaction: vi.fn().mockRejectedValue(new Error("private database payload")),
    };
    await expect(importFinancialCsv(
      { ...input, dryRun: false, confirmImport: true },
      { database: database as never, inspect: vi.fn().mockResolvedValue(inspected()) as never, acquire: vi.fn().mockResolvedValueOnce(fileLock).mockResolvedValueOnce(typeLock) as never },
      { ATTRIBUTION_IMPORT_ENABLED: "true" },
    )).rejects.toThrow("private database payload");
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "FAILED", errorMessage: "FINANCIAL_IMPORT_TRANSACTION_FAILED" }) }));
    expect(JSON.stringify(update.mock.calls)).not.toContain("private database payload");
  });

  it("aborts before transaction when lock ownership is lost", async () => {
    const fileLock = lock({ extend: vi.fn().mockResolvedValue(false) });
    const typeLock = lock();
    const database = { importJob: { create: vi.fn() } };
    await expect(importFinancialCsv(
      { ...input, dryRun: false, confirmImport: true },
      { database: database as never, inspect: vi.fn().mockResolvedValue(inspected()) as never, acquire: vi.fn().mockResolvedValueOnce(fileLock).mockResolvedValueOnce(typeLock) as never },
      { ATTRIBUTION_IMPORT_ENABLED: "true" },
    )).rejects.toThrow("FINANCIAL_IMPORT_LOCK_OWNERSHIP_LOST");
    expect(database.importJob.create).not.toHaveBeenCalled();
  });

  it("uses bounded retention and import configuration", () => {
    expect(attributionConfiguration({ ATTRIBUTION_IMPORT_MAX_ROWS: "9999999", TRACKING_CLICK_RETENTION_DAYS: "0" })).toMatchObject({ maxRows: 10_000, clickRetentionDays: 180, shopeeReportState: "WAITING_FOR_OFFICIAL_REPORT" });
  });

  it("preflight keeps dry-run available but confirmed import fail-closed", async () => {
    await expect(attributionPreflight({}, { redisHealth: async () => ({ mode: "unavailable", status: "unavailable" }) })).resolves.toMatchObject({
      dryRunAvailable: true,
      confirmedImportAvailable: false,
      blockers: ["CONFIRMED_IMPORTS_DISABLED", "REDIS_REQUIRED_FOR_CONFIRMED_IMPORT"],
    });
  });
});
