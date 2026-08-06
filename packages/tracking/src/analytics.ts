import { prisma, type Marketplace } from "@affiliate/database";

export type AnalyticsFilters = {
  from: Date;
  to: Date;
  marketplace?: Marketplace;
  channelId?: string;
};

export function validateAnalyticsPeriod(input: { from: Date; to: Date; maxDays?: number }) {
  const maxDays = input.maxDays ?? 366;
  if (Number.isNaN(input.from.getTime()) || Number.isNaN(input.to.getTime())) {
    throw new Error("ANALYTICS_PERIOD_INVALID");
  }
  if (input.to <= input.from) throw new Error("ANALYTICS_PERIOD_INVALID");
  if (input.to.getTime() - input.from.getTime() > maxDays * 86_400_000) {
    throw new Error("ANALYTICS_PERIOD_TOO_LARGE");
  }
  return { from: input.from, to: input.to };
}

export function safeConversionRate(conversions: number, clicks: number) {
  return clicks > 0 ? Math.round((conversions / clicks) * 10_000) / 100 : 0;
}

function decimal(value: unknown) {
  return value === null || value === undefined ? 0 : Number(value);
}

export async function collectAnalytics(
  filters: AnalyticsFilters,
  database = prisma,
) {
  validateAnalyticsPeriod(filters);
  const clickWhere = {
    createdAt: { gte: filters.from, lt: filters.to },
    ...(filters.marketplace ? { marketplace: filters.marketplace } : {}),
    ...(filters.channelId ? { channelId: filters.channelId } : {}),
  };
  const conversionWhere = {
    occurredAt: { gte: filters.from, lt: filters.to },
    ...(filters.marketplace ? { marketplace: filters.marketplace } : {}),
    ...(filters.channelId ? { channelId: filters.channelId } : {}),
  };
  const commissionWhere = { ...conversionWhere };
  const metricWhere = {
    day: { gte: filters.from, lt: filters.to },
    ...(filters.marketplace ? { marketplace: filters.marketplace } : {}),
  };
  const [
    clicks,
    uniqueFingerprints,
    conversions,
    attributedConversions,
    ambiguousConversions,
    commissionGroups,
    revenueGroups,
    trackingMetrics,
    clicksByMarketplace,
    conversionsByMarketplace,
    clicksByChannel,
    conversionsByChannel,
    clicksByOffer,
    conversionsByOffer,
    clicksByPublication,
    conversionsByPublication,
    importJobs,
  ] = await Promise.all([
    database.click.count({ where: clickWhere }),
    database.click.findMany({
      where: { ...clickWhere, fingerprintHash: { not: null } },
      distinct: ["fingerprintHash"],
      select: { fingerprintHash: true },
      take: 10_001,
    }),
    database.conversion.count({ where: conversionWhere }),
    database.conversion.count({ where: { ...conversionWhere, attributionStatus: { in: ["ATTRIBUTED_EXACT", "ATTRIBUTED_BY_SUB_ID", "ATTRIBUTED_LAST_CLICK"] } } }),
    database.conversion.count({ where: { ...conversionWhere, attributionStatus: "UNATTRIBUTED_AMBIGUOUS" } }),
    database.commission.groupBy({ by: ["currency", "status"], where: commissionWhere, _sum: { amount: true }, _count: { _all: true } }),
    database.conversion.groupBy({ by: ["currency"], where: conversionWhere, _sum: { amount: true }, _count: { _all: true } }),
    filters.channelId
      ? Promise.resolve({
          _sum: {
            redirects: null,
            clicksPersisted: null,
            clicksDeduplicated: null,
            clicksRateLimited: null,
            trackingDegraded: null,
            destinationsBlocked: null,
          },
        })
      : database.trackingDailyMetric.aggregate({ where: metricWhere, _sum: { redirects: true, clicksPersisted: true, clicksDeduplicated: true, clicksRateLimited: true, trackingDegraded: true, destinationsBlocked: true } }),
    database.click.groupBy({ by: ["marketplace"], where: clickWhere, _count: { _all: true } }),
    database.conversion.groupBy({ by: ["marketplace"], where: conversionWhere, _count: { _all: true } }),
    database.click.groupBy({ by: ["channelId"], where: clickWhere, _count: { _all: true }, orderBy: { _count: { channelId: "desc" } }, take: 20 }),
    database.conversion.groupBy({ by: ["channelId"], where: conversionWhere, _count: { _all: true }, orderBy: { _count: { channelId: "desc" } }, take: 20 }),
    database.click.groupBy({ by: ["offerId"], where: clickWhere, _count: { _all: true }, orderBy: { _count: { offerId: "desc" } }, take: 20 }),
    database.conversion.groupBy({ by: ["offerId"], where: conversionWhere, _count: { _all: true }, orderBy: { _count: { offerId: "desc" } }, take: 20 }),
    database.click.groupBy({ by: ["publicationId"], where: clickWhere, _count: { _all: true }, orderBy: { _count: { publicationId: "desc" } }, take: 20 }),
    database.conversion.groupBy({ by: ["publicationId"], where: conversionWhere, _count: { _all: true }, orderBy: { _count: { publicationId: "desc" } }, take: 20 }),
    database.importJob.findMany({
      where: { importType: { in: ["CONVERSION", "COMMISSION"] }, createdAt: { gte: filters.from, lt: filters.to }, ...(filters.marketplace ? { marketplace: filters.marketplace } : {}) },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { id: true, marketplace: true, importType: true, status: true, totalFound: true, totalCreated: true, totalFailed: true, createdAt: true },
    }),
  ]);
  const byKey = (
    clickRows: Array<{ [key: string]: unknown; _count: { _all: number } }>,
    conversionRows: Array<{ [key: string]: unknown; _count: { _all: number } }>,
    key: string,
  ) => {
    const conversionsMap = new Map(conversionRows.map((row) => [String(row[key] ?? "UNATTRIBUTED"), row._count._all]));
    const keys = new Set([
      ...clickRows.map((row) => String(row[key] ?? "UNATTRIBUTED")),
      ...conversionRows.map((row) => String(row[key] ?? "UNATTRIBUTED")),
    ]);
    return [...keys].slice(0, 20).map((value) => {
      const clickCount = clickRows.find((row) => String(row[key] ?? "UNATTRIBUTED") === value)?._count._all ?? 0;
      const conversionCount = conversionsMap.get(value) ?? 0;
      return { key: value.slice(0, 16), clicks: clickCount, conversions: conversionCount, conversionRate: safeConversionRate(conversionCount, clickCount) };
    });
  };
  const commissionCurrencyTotals = new Map<string, { amount: number; count: number }>();
  for (const row of commissionGroups) {
    const currency = row.currency ?? "UNKNOWN";
    const current = commissionCurrencyTotals.get(currency) ?? { amount: 0, count: 0 };
    current.amount += decimal(row._sum.amount);
    current.count += row._count._all;
    commissionCurrencyTotals.set(currency, current);
  }
  return {
    period: { from: filters.from.toISOString(), to: filters.to.toISOString() },
    trackingMetricsScope: filters.channelId ? "UNAVAILABLE_FOR_CHANNEL_FILTER" : "FILTERED_PERIOD_MARKETPLACE",
    clicks,
    uniqueClicksApproximate: Math.min(uniqueFingerprints.length, 10_000),
    uniqueClicksCapped: uniqueFingerprints.length > 10_000,
    conversions,
    attributedConversions,
    unattributedConversions: Math.max(0, conversions - attributedConversions),
    ambiguousConversions,
    conversionRate: safeConversionRate(conversions, clicks),
    redirects: trackingMetrics._sum.redirects ?? 0,
    clicksPersisted: trackingMetrics._sum.clicksPersisted ?? 0,
    clicksDeduplicated: trackingMetrics._sum.clicksDeduplicated ?? 0,
    clicksRateLimited: trackingMetrics._sum.clicksRateLimited ?? 0,
    trackingDegraded: trackingMetrics._sum.trackingDegraded ?? 0,
    destinationsBlocked: trackingMetrics._sum.destinationsBlocked ?? 0,
    revenueByCurrency: revenueGroups.map((row) => ({ currency: row.currency ?? "UNKNOWN", amount: decimal(row._sum.amount), conversions: row._count._all })),
    commissionsByCurrencyAndStatus: commissionGroups.map((row) => ({ currency: row.currency ?? "UNKNOWN", status: row.status, amount: decimal(row._sum.amount), commissions: row._count._all })),
    averageCommissionByCurrency: [...commissionCurrencyTotals].map(([currency, total]) => ({
      currency,
      average: total.count > 0 ? Math.round((total.amount / total.count) * 100) / 100 : 0,
      commissions: total.count,
    })),
    byMarketplace: byKey(clicksByMarketplace, conversionsByMarketplace, "marketplace"),
    byChannel: byKey(clicksByChannel, conversionsByChannel, "channelId"),
    byOffer: byKey(clicksByOffer, conversionsByOffer, "offerId"),
    byPublication: byKey(clicksByPublication, conversionsByPublication, "publicationId"),
    imports: importJobs.map((job) => ({ ...job, id: job.id.slice(0, 12), createdAt: job.createdAt.toISOString() })),
  };
}
