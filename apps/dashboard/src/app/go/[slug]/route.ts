import { NextResponse, type NextRequest } from "next/server";
import { prisma, Prisma } from "@affiliate/database";
import { consumeFixedWindow } from "@affiliate/redis";
import {
  classifyUserAgent,
  createTemporaryFingerprint,
  redisSafeKeyPart,
  sanitizeRefererHost,
  trackingConfiguration,
  trustedClientAddress,
  validateTrackingDestination,
} from "@affiliate/tracking";

type RouteContext = {
  params: Promise<{ slug: string }>;
};

type TrackingMetric =
  | "redirects"
  | "clicksPersisted"
  | "clicksDeduplicated"
  | "clicksRateLimited"
  | "trackingDegraded"
  | "destinationsBlocked";

function metricDay(now: Date) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

async function recordMetric(
  marketplace: "MERCADO_LIVRE" | "SHOPEE",
  now: Date,
  metrics: readonly TrackingMetric[],
) {
  const create = Object.fromEntries(metrics.map((metric) => [metric, 1]));
  const update = Object.fromEntries(metrics.map((metric) => [metric, { increment: 1 }]));
  try {
    await prisma.trackingDailyMetric.upsert({
      where: { day_marketplace: { day: metricDay(now), marketplace } },
      create: { day: metricDay(now), marketplace, ...create },
      update,
    });
  } catch {
    // Metrics are best effort and must never alter redirect behavior.
  }
}

async function unambiguousPublicationForOffer(offerId: string) {
  const rows = await prisma.publication.findMany({
    where: {
      offerId,
      status: { in: ["PUBLISHED", "EXPORTED", "SCHEDULED"] },
    },
    orderBy: [{ publishedAt: "desc" }, { scheduledAt: "desc" }],
    take: 2,
    select: { id: true, channelId: true },
  });
  return rows.length === 1 ? rows[0]! : null;
}

function safeTrackingLog(event: string, errorCode?: string) {
  const value = { event, ...(errorCode ? { errorCode } : {}) };
  if (event === "TRACKING_REDIRECT_BLOCKED" || event === "TRACKING_DEGRADED") {
    console.warn(JSON.stringify(value));
  }
}

export async function GET(request: NextRequest, context: RouteContext) {
  const now = new Date();
  const { slug } = await context.params;
  const affiliateLink = await prisma.affiliateLink.findUnique({
    where: { slug },
    select: {
      id: true,
      offerId: true,
      destination: true,
      marketplace: true,
      active: true,
    },
  });

  if (!affiliateLink?.active) {
    return new NextResponse("Link indisponível.", { status: 404 });
  }

  const destination = validateTrackingDestination({
    destination: affiliateLink.destination,
    marketplace: affiliateLink.marketplace,
  });
  if (!destination.ok) {
    await recordMetric(affiliateLink.marketplace, now, ["destinationsBlocked"]);
    safeTrackingLog("TRACKING_REDIRECT_BLOCKED", destination.code);
    return new NextResponse("Link indisponível.", { status: 404 });
  }

  const redirect = () => NextResponse.redirect(destination.normalizedUrl, 302);
  const configuration = trackingConfiguration();
  if (!configuration.enabled) {
    await recordMetric(affiliateLink.marketplace, now, ["redirects"]);
    return redirect();
  }

  const userAgent = request.headers.get("user-agent");
  const clientAddress = trustedClientAddress(request.headers);
  const fingerprint = createTemporaryFingerprint({
    secret: process.env.TRACKING_FINGERPRINT_SECRET,
    clientAddress,
    userAgent,
    slug,
    now,
    windowSeconds: configuration.dedupWindowSeconds,
  });
  if (!fingerprint) {
    await recordMetric(affiliateLink.marketplace, now, ["redirects", "trackingDegraded"]);
    safeTrackingLog("TRACKING_DEGRADED", "FINGERPRINT_UNAVAILABLE");
    return redirect();
  }
  const clientRateFingerprint = createTemporaryFingerprint({
    secret: process.env.TRACKING_FINGERPRINT_SECRET,
    clientAddress,
    userAgent,
    slug: "rate-limit",
    now,
    windowSeconds: 60,
  });
  if (!clientRateFingerprint) {
    await recordMetric(affiliateLink.marketplace, now, ["redirects", "trackingDegraded"]);
    safeTrackingLog("TRACKING_DEGRADED", "CLIENT_RATE_FINGERPRINT_UNAVAILABLE");
    return redirect();
  }

  const slugKey = redisSafeKeyPart(slug);
  const fingerprintKey = redisSafeKeyPart(fingerprint.hash);
  const clientRateKey = redisSafeKeyPart(clientRateFingerprint.hash);
  const limits = configuration.rateLimitEnabled
    ? await Promise.all([
        consumeFixedWindow(
          `tracking:rate:slug:${slugKey}`,
          configuration.rateLimitPerSlugPerMinute,
          60,
        ),
        consumeFixedWindow(
          `tracking:rate:client:${clientRateKey}`,
          configuration.rateLimitPerClientPerMinute,
          60,
        ),
      ])
    : [];
  if (limits.some((result) => !result.available)) {
    await recordMetric(affiliateLink.marketplace, now, ["redirects", "trackingDegraded"]);
    safeTrackingLog("TRACKING_DEGRADED", "REDIS_UNAVAILABLE");
    return redirect();
  }
  if (limits.some((result) => !result.allowed)) {
    await recordMetric(affiliateLink.marketplace, now, ["redirects", "clicksRateLimited"]);
    return redirect();
  }
  const dedup = await consumeFixedWindow(
    `tracking:dedup:${redisSafeKeyPart(affiliateLink.id)}:${fingerprintKey}:${fingerprint.windowStart.getTime()}`,
    1,
    configuration.dedupWindowSeconds,
  );
  if (!dedup.available) {
    await recordMetric(affiliateLink.marketplace, now, ["redirects", "trackingDegraded"]);
    safeTrackingLog("TRACKING_DEGRADED", "REDIS_UNAVAILABLE");
    return redirect();
  }
  if (!dedup.allowed) {
    await recordMetric(affiliateLink.marketplace, now, ["redirects", "clicksDeduplicated"]);
    return redirect();
  }

  try {
    const publication = await unambiguousPublicationForOffer(affiliateLink.offerId);
    await prisma.click.create({
      data: {
        affiliateLinkId: affiliateLink.id,
        offerId: affiliateLink.offerId,
        publicationId: publication?.id ?? null,
        channelId: publication?.channelId ?? null,
        marketplace: affiliateLink.marketplace,
        userAgent: null,
        referer: null,
        fingerprintHash: fingerprint.hash,
        fingerprintWindowStart: fingerprint.windowStart,
        refererHost: sanitizeRefererHost(request.headers.get("referer")),
        userAgentCategory: classifyUserAgent(userAgent),
      },
    });
    await recordMetric(affiliateLink.marketplace, now, ["redirects", "clicksPersisted"]);
  } catch (error) {
    const duplicate = error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
    await recordMetric(affiliateLink.marketplace, now, [
      "redirects",
      duplicate ? "clicksDeduplicated" : "trackingDegraded",
    ]);
    if (!duplicate) safeTrackingLog("TRACKING_DEGRADED", "CLICK_PERSISTENCE_FAILED");
  }

  return redirect();
}
