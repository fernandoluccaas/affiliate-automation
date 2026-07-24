import { prisma } from "@affiliate/database";

export type ClickSeriesPoint = {
  day: string;
  date: string;
  clicks: number;
};

export type DashboardMetrics = {
  readyOffers: number;
  publicationsToday: number;
  clicksToday: number;
  openAlerts: number;
  clickSeries: ClickSeriesPoint[];
};

function startOfDay(date: Date) {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function dateKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function dayLabel(date: Date) {
  return new Intl.DateTimeFormat("pt-BR", { weekday: "short" }).format(date).replace(".", "");
}

export async function getDashboardMetrics(now = new Date()): Promise<DashboardMetrics> {
  const today = startOfDay(now);
  const tomorrow = addDays(today, 1);
  const firstSeriesDay = addDays(today, -6);

  const [readyOffers, publicationsToday, clicksToday, openAlerts, recentClicks] = await Promise.all([
    prisma.offer.count({ where: { status: "READY_TO_PUBLISH" } }),
    prisma.publication.count({
      where: {
        status: "PUBLISHED",
        publishedAt: { gte: today, lt: tomorrow },
      },
    }),
    prisma.click.count({ where: { createdAt: { gte: today, lt: tomorrow } } }),
    prisma.systemAlert.count({ where: { acknowledged: false } }),
    prisma.click.findMany({
      where: { createdAt: { gte: firstSeriesDay, lt: tomorrow } },
      select: { createdAt: true },
    }),
  ]);

  const totalsByDay = new Map<string, number>();

  for (const click of recentClicks) {
    const key = dateKey(startOfDay(click.createdAt));
    totalsByDay.set(key, (totalsByDay.get(key) ?? 0) + 1);
  }

  const clickSeries = Array.from({ length: 7 }, (_item, index) => {
    const date = addDays(firstSeriesDay, index);
    const key = dateKey(date);

    return {
      day: dayLabel(date),
      date: key,
      clicks: totalsByDay.get(key) ?? 0,
    };
  });

  return {
    readyOffers,
    publicationsToday,
    clicksToday,
    openAlerts,
    clickSeries,
  };
}
