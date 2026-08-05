export const marketplaces = ["SHOPEE", "MERCADO_LIVRE"] as const;
export type Marketplace = (typeof marketplaces)[number];

export const offerStatuses = [
  "PENDING_VALIDATION",
  "REJECTED_INVALID_DATA",
  "REJECTED_EXPIRED",
  "REJECTED_DUPLICATE",
  "REJECTED_LOW_SCORE",
  "QUARANTINED_INTEGRATION_ERROR",
  "READY_FOR_AFFILIATE_LINK",
  "READY_TO_PUBLISH",
  "SCHEDULED",
  "PUBLISHED",
  "PUBLICATION_FAILED",
] as const;
export type OfferStatus = (typeof offerStatuses)[number];

export const stockStatuses = ["IN_STOCK", "OUT_OF_STOCK", "UNKNOWN"] as const;
export type StockStatus = (typeof stockStatuses)[number];

export const shippingStatuses = ["FREE", "NOT_FREE", "UNKNOWN"] as const;
export type ShippingStatus = (typeof shippingStatuses)[number];

export const channelTypes = [
  "TELEGRAM",
  "MANUAL_EXPORT",
  "WHATSAPP_GROUPS",
  // Legacy: retained only for existing records created during Phase 5A.
  "WHATSAPP_CHANNEL",
  "WHATSAPP_CLOUD_API",
  "WHATSAPP_GROUPS_API",
] as const;
export type ChannelType = (typeof channelTypes)[number];

export const DEFAULT_WORKER_HEARTBEAT_INTERVAL_MS = 30_000;
export const DEFAULT_WORKER_STALE_AFTER_MS =
  DEFAULT_WORKER_HEARTBEAT_INTERVAL_MS * 3;
export const DEFAULT_WORKER_CLOCK_SKEW_TOLERANCE_MS = 5_000;

export type WorkerHealthStatus = "ONLINE" | "OFFLINE" | "STALE";

export function resolveWorkerHealthStatus(input: {
  storedState: unknown;
  heartbeatAt: Date | string | null | undefined;
  now?: Date;
  staleAfterMs?: number;
  clockSkewToleranceMs?: number;
}): WorkerHealthStatus {
  if (input.storedState === "OFFLINE") {
    return "OFFLINE";
  }

  const now = input.now ?? new Date();
  const staleAfterMs =
    input.staleAfterMs ?? DEFAULT_WORKER_STALE_AFTER_MS;
  const clockSkewToleranceMs =
    input.clockSkewToleranceMs ?? DEFAULT_WORKER_CLOCK_SKEW_TOLERANCE_MS;
  const heartbeatTime = input.heartbeatAt
    ? new Date(input.heartbeatAt).getTime()
    : Number.NaN;
  const elapsed = now.getTime() - heartbeatTime;

  if (
    !Number.isFinite(heartbeatTime) ||
    !Number.isFinite(elapsed) ||
    elapsed < -clockSkewToleranceMs ||
    elapsed > staleAfterMs
  ) {
    return "STALE";
  }

  return "ONLINE";
}

export function isSupportedMarketplace(value: string): value is Marketplace {
  return marketplaces.includes(value as Marketplace);
}

export function calculateDiscountPercentage(originalPrice: number, currentPrice: number) {
  if (originalPrice <= 0 || currentPrice < 0 || currentPrice > originalPrice) {
    return 0;
  }

  return Number((((originalPrice - currentPrice) / originalPrice) * 100).toFixed(2));
}
