import { readFile, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { prisma, type Marketplace } from "@affiliate/database";
import { acquireLock, getRedisHealth } from "@affiliate/redis";
import { resolveAttributionWithDatabase } from "./attribution";
import {
  financialAdapterStatus,
  parseFinancialCsv,
  type CanonicalCommissionRow,
  type CanonicalConversionRow,
  type FinancialCsvMarketplace,
  type FinancialImportType,
} from "./csv";

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

export function attributionConfiguration(env: NodeJS.ProcessEnv = process.env) {
  return {
    confirmedImportsEnabled: env.ATTRIBUTION_IMPORT_ENABLED === "true",
    defaultWindowHours: boundedInteger(env.ATTRIBUTION_DEFAULT_WINDOW_HOURS, 168, 1, 8_760),
    maxBytes: boundedInteger(env.ATTRIBUTION_IMPORT_MAX_FILE_BYTES, 5_242_880, 1_024, 50_000_000),
    maxRows: boundedInteger(env.ATTRIBUTION_IMPORT_MAX_ROWS, 10_000, 1, 100_000),
    lockTtlSeconds: boundedInteger(env.ATTRIBUTION_IMPORT_LOCK_TTL_SECONDS, 300, 30, 3_600),
    clickRetentionDays: boundedInteger(env.TRACKING_CLICK_RETENTION_DAYS, 180, 1, 3_650),
    shopeeReportState: "WAITING_FOR_OFFICIAL_REPORT",
  } as const;
}

export async function attributionPreflight(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: { redisHealth?: typeof getRedisHealth } = {},
) {
  const configuration = attributionConfiguration(env);
  const redis = await (dependencies.redisHealth ?? getRedisHealth)();
  return {
    ...configuration,
    redis: redis.status === "ok" ? "AVAILABLE" : "UNAVAILABLE",
    dryRunAvailable: true,
    confirmedImportAvailable:
      configuration.confirmedImportsEnabled && redis.status === "ok",
    blockers: [
      ...(!configuration.confirmedImportsEnabled ? ["CONFIRMED_IMPORTS_DISABLED"] : []),
      ...(redis.status !== "ok" ? ["REDIS_REQUIRED_FOR_CONFIRMED_IMPORT"] : []),
    ],
  };
}

export type InspectFinancialCsvInput = {
  file: string;
  marketplace: FinancialCsvMarketplace;
  type: FinancialImportType;
  dateFormat?: "ISO" | "BR";
  decimalFormat?: "DOT" | "BR";
};

function validatePath(file: string) {
  if (file.split(/[\\/]/).includes("..") || extname(file).toLowerCase() !== ".csv") {
    throw new Error("FINANCIAL_CSV_PATH_INVALID");
  }
  return resolve(file);
}

export async function inspectFinancialCsv(
  input: InspectFinancialCsvInput,
  database = prisma,
  env: NodeJS.ProcessEnv = process.env,
) {
  const file = validatePath(input.file);
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) throw new Error("FINANCIAL_CSV_NOT_FILE");
  const configuration = attributionConfiguration(env);
  if (info.size > configuration.maxBytes) throw new Error("FINANCIAL_CSV_FILE_TOO_LARGE");
  const parsed = parseFinancialCsv(await readFile(file), input.type, {
    marketplace: input.marketplace,
    ...(input.dateFormat ? { dateFormat: input.dateFormat } : {}),
    ...(input.decimalFormat ? { decimalFormat: input.decimalFormat } : {}),
    maxBytes: configuration.maxBytes,
    maxRows: configuration.maxRows,
    ...(env.ATTRIBUTION_SUB_ID_SECRET
      ? { subIdSecret: env.ATTRIBUTION_SUB_ID_SECRET }
      : {}),
  });
  const ids = parsed.rows.map((row) => row.externalEventId);
  const existing = input.type === "CONVERSION"
    ? await database.conversion.findMany({
        where: { marketplace: input.marketplace, externalEventId: { in: ids } },
        select: { externalEventId: true },
      })
    : await database.commission.findMany({
        where: { marketplace: input.marketplace, externalEventId: { in: ids } },
        select: { externalEventId: true },
      });
  const existingIds = new Set(existing.map((item) => item.externalEventId).filter(Boolean));
  let attributed = 0;
  let unattributed = 0;
  let ambiguous = 0;
  let orphanCommissions = 0;
  const attributionDecisions = new Map<string, Awaited<ReturnType<typeof resolveAttributionWithDatabase>>>();
  if (input.type === "CONVERSION") {
    for (const row of parsed.rows as CanonicalConversionRow[]) {
      if (existingIds.has(row.externalEventId)) continue;
      const decision = await resolveAttributionWithDatabase({
        database,
        marketplace: input.marketplace as Marketplace,
        occurredAt: row.occurredAt,
        windowHours: row.attributionWindowHours ?? configuration.defaultWindowHours,
        references: {
          clickReference: row.clickReference,
          subId: row.subId,
          affiliateSlug: row.affiliateSlug,
          publicationReference: row.publicationReference,
          offerReference: row.offerReference,
        },
      });
      attributionDecisions.set(row.externalEventId, decision);
      if (decision.status.startsWith("ATTRIBUTED_")) attributed += 1;
      else if (decision.status === "UNATTRIBUTED_AMBIGUOUS") ambiguous += 1;
      else unattributed += 1;
    }
  } else {
    const conversionReferences = (parsed.rows as CanonicalCommissionRow[])
      .map((row) => row.conversionExternalEventId)
      .filter((value): value is string => Boolean(value));
    const conversions = conversionReferences.length
      ? await database.conversion.findMany({
          where: { marketplace: input.marketplace, externalEventId: { in: conversionReferences } },
          select: { externalEventId: true },
        })
      : [];
    const conversionIds = new Set(conversions.map((item) => item.externalEventId).filter(Boolean));
    orphanCommissions = (parsed.rows as CanonicalCommissionRow[]).filter(
      (row) => !row.conversionExternalEventId || !conversionIds.has(row.conversionExternalEventId),
    ).length;
  }
  const summary = {
    totalRows: parsed.rows.length + parsed.issues.filter((issue) => issue.line > 1).length,
    validRows: parsed.rows.length,
    invalidRows: parsed.issues.length,
    duplicateRows: parsed.duplicates,
    existingEvents: parsed.rows.filter((row) => existingIds.has(row.externalEventId)).length,
    newEvents: parsed.rows.filter((row) => !existingIds.has(row.externalEventId)).length,
    attributed,
    unattributed,
    ambiguous,
    orphanCommissions,
    errorsByCode: Object.fromEntries(
      [...new Set(parsed.issues.map((issue) => issue.code))].map((code) => [
        code,
        parsed.issues.filter((issue) => issue.code === code).length,
      ]),
    ),
  };
  return {
    ...parsed,
    adapter: financialAdapterStatus(input.marketplace),
    summary,
    existingIds,
    attributionDecisions,
  };
}

export type FinancialImportDependencies = {
  database: typeof prisma;
  acquire: typeof acquireLock;
  inspect: typeof inspectFinancialCsv;
};

const defaultDependencies: FinancialImportDependencies = {
  database: prisma,
  acquire: acquireLock,
  inspect: inspectFinancialCsv,
};

export async function importFinancialCsv(
  input: InspectFinancialCsvInput & { dryRun: boolean; confirmImport: boolean },
  overrides: Partial<FinancialImportDependencies> = {},
  env: NodeJS.ProcessEnv = process.env,
) {
  if (input.dryRun === input.confirmImport) {
    throw new Error("CHOOSE_EXACTLY_ONE_OF_DRY_RUN_OR_CONFIRM_IMPORT");
  }
  const dependencies = { ...defaultDependencies, ...overrides };
  const inspected = await dependencies.inspect(input, dependencies.database, env);
  if (input.dryRun) {
    return {
      event: input.type === "CONVERSION"
        ? "CONVERSION_IMPORT_DRY_RUN_COMPLETED"
        : "COMMISSION_IMPORT_DRY_RUN_COMPLETED",
      status: "DRY_RUN",
      checksum: inspected.checksum,
      ...inspected.summary,
      databaseWrites: 0,
    };
  }
  if (!attributionConfiguration(env).confirmedImportsEnabled) {
    throw new Error("CONFIRMED_FINANCIAL_IMPORTS_DISABLED");
  }
  const checksumKey = `financial-import:file:${inspected.checksum}`;
  const typeKey = `financial-import:${input.marketplace}:${input.type}`;
  const lockTtlMs = attributionConfiguration(env).lockTtlSeconds * 1_000;
  const fileLock = await dependencies.acquire(checksumKey, lockTtlMs, { env, requireRedis: true });
  if (!fileLock.acquired) throw new Error("FINANCIAL_IMPORT_FILE_LOCK_UNAVAILABLE");
  const typeLock = await dependencies.acquire(typeKey, lockTtlMs, { env, requireRedis: true });
  if (!typeLock.acquired) {
    await fileLock.release();
    throw new Error("FINANCIAL_IMPORT_TYPE_LOCK_UNAVAILABLE");
  }
  try {
    if (!(await fileLock.extend(lockTtlMs)) || !(await typeLock.extend(lockTtlMs))) {
      throw new Error("FINANCIAL_IMPORT_LOCK_OWNERSHIP_LOST");
    }
    const previous = await dependencies.database.importJob.findFirst({
      where: {
        marketplace: input.marketplace,
        importType: input.type,
        fileChecksum: inspected.checksum,
        status: { in: ["SUCCEEDED", "SUCCEEDED_WITH_ERRORS"] },
      },
      select: { id: true },
    });
    if (previous) {
      const duplicate = await dependencies.database.importJob.create({
        data: {
          marketplace: input.marketplace,
          importType: input.type,
          fileChecksum: inspected.checksum,
          adapterVersion: inspected.adapter.adapterVersion,
          source: `FINANCIAL_CSV:${input.type}:DUPLICATE`,
          status: "DUPLICATE",
          startedAt: new Date(),
          finishedAt: new Date(),
          summary: { originalImportJobId: previous.id.slice(0, 24), checksum: inspected.checksum },
        },
      });
      return { status: "DUPLICATE", importJobId: duplicate.id, originalImportJobId: previous.id, checksum: inspected.checksum, created: 0, skipped: inspected.rows.length };
    }
    const job = await dependencies.database.importJob.create({
      data: {
        marketplace: input.marketplace,
        importType: input.type,
        fileChecksum: inspected.checksum,
        adapterVersion: inspected.adapter.adapterVersion,
        source: `FINANCIAL_CSV:${input.type}`,
        status: "RUNNING",
        startedAt: new Date(),
        totalFound: inspected.summary.totalRows,
        summary: { checksum: inspected.checksum, format: "CANONICAL_V1", adapterVersion: inspected.adapter.adapterVersion },
      },
    });
    try {
      const result = await dependencies.database.$transaction(async (transaction) => {
        let created = 0;
        let skipped = 0;
        for (const issue of inspected.issues) {
          await transaction.importJobItem.create({
            data: {
              importJobId: job.id,
              sourceType: input.type,
              stage: "VALIDATION",
              status: "FAILED",
              errorCode: issue.code,
              metadata: { line: issue.line },
            },
          });
        }
        for (const row of inspected.rows) {
          if (!(await fileLock.extend(lockTtlMs)) || !(await typeLock.extend(lockTtlMs))) {
            throw new Error("FINANCIAL_IMPORT_LOCK_OWNERSHIP_LOST");
          }
          if (inspected.existingIds.has(row.externalEventId)) {
            skipped += 1;
            await transaction.importJobItem.create({
              data: {
                importJobId: job.id,
                sourceId: row.externalEventId,
                sourceType: input.type,
                stage: "PERSISTENCE",
                status: "SKIPPED",
                errorCode: "DUPLICATE_EVENT",
                metadata: { line: row.line },
              },
            });
            continue;
          }
          if (input.type === "CONVERSION") {
            const conversionRow = row as CanonicalConversionRow;
            const decision = inspected.attributionDecisions.get(row.externalEventId)!;
            const conversion = await transaction.conversion.create({
              data: {
                marketplace: input.marketplace,
                externalEventId: conversionRow.externalEventId,
                externalOrderId: conversionRow.externalOrderId,
                externalItemId: conversionRow.externalItemId,
                amount: conversionRow.amount,
                currency: conversionRow.currency,
                occurredAt: conversionRow.occurredAt,
                clickId: decision.clickId,
                affiliateLinkId: decision.affiliateLinkId,
                publicationId: decision.publicationId,
                offerId: decision.offerId,
                channelId: decision.channelId,
                attributionStatus: decision.status,
                attributionMethod: decision.method,
                attributionMatchQuality: decision.matchQuality,
                attributedAt: decision.attributedAt,
                attributionWindowHours: decision.attributionWindowHours,
                externalSubId: conversionRow.subId,
                attributionMetadata: decision.metadata,
              },
            });
            await transaction.importJobItem.create({
              data: {
                importJobId: job.id,
                sourceId: row.externalEventId,
                sourceType: input.type,
                conversionId: conversion.id,
                offerId: decision.offerId,
                stage: "PERSISTENCE",
                status: "SUCCEEDED",
                metadata: { line: row.line, attributionStatus: decision.status, attributionMethod: decision.method },
              },
            });
          } else {
            const commissionRow = row as CanonicalCommissionRow;
            const conversion = commissionRow.conversionExternalEventId
              ? await transaction.conversion.findUnique({
                  where: {
                    marketplace_externalEventId: {
                      marketplace: input.marketplace,
                      externalEventId: commissionRow.conversionExternalEventId,
                    },
                  },
                  select: { id: true, offerId: true, publicationId: true, channelId: true },
                })
              : null;
            const commission = await transaction.commission.create({
              data: {
                marketplace: input.marketplace,
                externalEventId: commissionRow.externalEventId,
                externalOrderId: commissionRow.externalOrderId,
                externalItemId: commissionRow.externalItemId,
                amount: commissionRow.amount,
                currency: commissionRow.currency,
                percentage: commissionRow.percentage,
                status: commissionRow.status,
                occurredAt: commissionRow.occurredAt,
                conversionId: conversion?.id ?? null,
                offerId: conversion?.offerId ?? null,
                publicationId: conversion?.publicationId ?? null,
                channelId: conversion?.channelId ?? null,
                metadata: { orphan: !conversion, source: "CANONICAL_CSV_V1" },
              },
            });
            await transaction.importJobItem.create({
              data: {
                importJobId: job.id,
                sourceId: row.externalEventId,
                sourceType: input.type,
                commissionId: commission.id,
                offerId: conversion?.offerId ?? null,
                stage: "PERSISTENCE",
                status: "SUCCEEDED",
                metadata: { line: row.line, orphan: !conversion },
              },
            });
          }
          created += 1;
        }
        const failed = inspected.issues.length;
        await transaction.importJob.update({
          where: { id: job.id },
          data: {
            status: failed ? "SUCCEEDED_WITH_ERRORS" : "SUCCEEDED",
            finishedAt: new Date(),
            totalResolved: inspected.rows.length,
            totalCreated: created,
            totalUpdated: 0,
            totalFailed: failed,
            summary: { checksum: inspected.checksum, format: "CANONICAL_V1", created, skipped, invalid: failed },
          },
        });
        return { created, skipped, failed };
      });
      return {
        event: input.type === "CONVERSION" ? "CONVERSION_IMPORT_SUCCEEDED" : "COMMISSION_IMPORT_SUCCEEDED",
        status: result.failed ? "SUCCEEDED_WITH_ERRORS" : "SUCCEEDED",
        importJobId: job.id,
        checksum: inspected.checksum,
        ...result,
      };
    } catch (error) {
      await dependencies.database.importJob.update({
        where: { id: job.id },
        data: { status: "FAILED", finishedAt: new Date(), errorMessage: "FINANCIAL_IMPORT_TRANSACTION_FAILED", totalFailed: inspected.rows.length },
      });
      throw error;
    }
  } finally {
    await typeLock.release();
    await fileLock.release();
  }
}

export function sanitizeFinancialOperationError(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  return /^[A-Z0-9_]+$/.test(message) ? message : "FINANCIAL_OPERATION_FAILED";
}
