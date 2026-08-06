import { prisma } from "@affiliate/database";
import { trackingConfiguration, trackingPreflight } from "./index";

export type TrackingOperationalState = {
  available: boolean;
  lastConversionImport: null | {
    status: string;
    createdAt: string;
    validRows: number;
    failedRows: number;
  };
  lastCommissionImport: null | {
    status: string;
    createdAt: string;
    validRows: number;
    failedRows: number;
  };
  unattributedConversions: number;
  orphanCommissions: number;
  abandonedImports: number;
  failedImports: number;
  duplicateImports: number;
};

const unavailableState: TrackingOperationalState = {
  available: false,
  lastConversionImport: null,
  lastCommissionImport: null,
  unattributedConversions: 0,
  orphanCommissions: 0,
  abandonedImports: 0,
  failedImports: 0,
  duplicateImports: 0,
};

function importView(job: {
  status: string;
  createdAt: Date;
  totalResolved: number;
  totalFailed: number;
} | null) {
  return job
    ? {
        status: job.status,
        createdAt: job.createdAt.toISOString(),
        validRows: job.totalResolved,
        failedRows: job.totalFailed,
      }
    : null;
}

export async function collectTrackingOperationalState(
  database = prisma,
  now = new Date(),
): Promise<TrackingOperationalState> {
  try {
    const staleBefore = new Date(now.getTime() - 60 * 60_000);
    const [
      lastConversion,
      lastCommission,
      unattributedConversions,
      orphanCommissions,
      abandonedImports,
      failedImports,
      duplicateImports,
    ] = await Promise.all([
      database.importJob.findFirst({
        where: { importType: "CONVERSION" },
        orderBy: { createdAt: "desc" },
        select: {
          status: true,
          createdAt: true,
          totalResolved: true,
          totalFailed: true,
        },
      }),
      database.importJob.findFirst({
        where: { importType: "COMMISSION" },
        orderBy: { createdAt: "desc" },
        select: {
          status: true,
          createdAt: true,
          totalResolved: true,
          totalFailed: true,
        },
      }),
      database.conversion.count({
        where: {
          attributionStatus: {
            in: ["UNATTRIBUTED_NO_CLICK", "UNATTRIBUTED_AMBIGUOUS"],
          },
        },
      }),
      database.commission.count({ where: { conversionId: null } }),
      database.importJob.count({
        where: {
          importType: { in: ["CONVERSION", "COMMISSION"] },
          status: "RUNNING",
          startedAt: { lt: staleBefore },
        },
      }),
      database.importJob.count({
        where: { importType: { in: ["CONVERSION", "COMMISSION"] }, status: "FAILED" },
      }),
      database.importJob.count({
        where: { importType: { in: ["CONVERSION", "COMMISSION"] }, status: "DUPLICATE" },
      }),
    ]);
    return {
      available: true,
      lastConversionImport: importView(lastConversion),
      lastCommissionImport: importView(lastCommission),
      unattributedConversions,
      orphanCommissions,
      abandonedImports,
      failedImports,
      duplicateImports,
    };
  } catch {
    return unavailableState;
  }
}

export async function trackingStatusSnapshot(
  env: NodeJS.ProcessEnv = process.env,
  database = prisma,
) {
  const [preflight, operational] = await Promise.all([
    trackingPreflight(env),
    collectTrackingOperationalState(database),
  ]);
  return {
    configuration: trackingConfiguration(env),
    preflight,
    operational,
  };
}

export async function collectTrackingRetentionReport(
  database = prisma,
  env: NodeJS.ProcessEnv = process.env,
  now = new Date(),
) {
  const retentionDays = trackingConfiguration(env).clickRetentionDays;
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
  const [pastRetention, oldest] = await Promise.all([
    database.click.count({ where: { createdAt: { lt: cutoff } } }),
    database.click.findFirst({ orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
  ]);
  return {
    status: "TRACKING_RETENTION_REPORT",
    retentionDays,
    cutoff: cutoff.toISOString(),
    clicksPastRetention: pastRetention,
    oldestClickAt: oldest?.createdAt.toISOString() ?? null,
    purgeAvailable: false,
    stateModified: false,
  };
}
