import { createHash, createHmac } from "node:crypto";
import { isIP } from "node:net";
import { getRedisHealth } from "@affiliate/redis";

export type TrackingMarketplace = "MERCADO_LIVRE" | "SHOPEE";

const DESTINATION_DOMAINS: Record<TrackingMarketplace, readonly string[]> = {
  MERCADO_LIVRE: ["meli.la", "mercadolivre.com.br", "mercadolibre.com"],
  SHOPEE: ["shopee.com.br"],
};

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max
    ? parsed
    : fallback;
}

export function trackingConfiguration(env: NodeJS.ProcessEnv = process.env) {
  const enabled = env.TRACKING_ENABLED !== "false";
  const fingerprintSecretConfigured = Boolean(
    env.TRACKING_FINGERPRINT_SECRET && env.TRACKING_FINGERPRINT_SECRET.length >= 32,
  );
  const subIdSecretConfigured = Boolean(
    env.ATTRIBUTION_SUB_ID_SECRET && env.ATTRIBUTION_SUB_ID_SECRET.length >= 32,
  );
  const rateLimitEnabled = env.TRACKING_RATE_LIMIT_ENABLED !== "false";
  const failMode = env.TRACKING_RATE_LIMIT_FAIL_MODE === "ALLOW_REDIRECT_WITHOUT_TRACKING"
    ? "ALLOW_REDIRECT_WITHOUT_TRACKING"
    : "ALLOW_REDIRECT_WITHOUT_TRACKING";
  return {
    enabled,
    rateLimitEnabled,
    rateLimitPerClientPerMinute: boundedInteger(
      env.TRACKING_RATE_LIMIT_PER_CLIENT_PER_MINUTE,
      30,
      1,
      10_000,
    ),
    rateLimitPerSlugPerMinute: boundedInteger(
      env.TRACKING_RATE_LIMIT_PER_SLUG_PER_MINUTE,
      300,
      1,
      100_000,
    ),
    dedupWindowSeconds: boundedInteger(env.TRACKING_DEDUP_WINDOW_SECONDS, 30, 5, 3_600),
    attributionWindowHours: boundedInteger(
      env.ATTRIBUTION_DEFAULT_WINDOW_HOURS,
      168,
      1,
      8_760,
    ),
    clickRetentionDays: boundedInteger(env.TRACKING_CLICK_RETENTION_DAYS, 180, 1, 3_650),
    fingerprintSecretConfigured,
    subIdSecretConfigured,
    trustProxyHeaders: env.TRACKING_TRUST_PROXY_HEADERS === "true",
    failMode,
    state: !enabled
      ? "DISABLED"
      : !fingerprintSecretConfigured
        ? "DEGRADED_MISSING_FINGERPRINT_SECRET"
        : "CONFIGURED",
  } as const;
}

export async function trackingPreflight(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: { redisHealth?: typeof getRedisHealth } = {},
) {
  const configuration = trackingConfiguration(env);
  const redis = await (dependencies.redisHealth ?? getRedisHealth)();
  const blockers = [
    ...(!configuration.enabled ? ["TRACKING_DISABLED"] : []),
    ...(!configuration.fingerprintSecretConfigured
      ? ["TRACKING_FINGERPRINT_SECRET_MISSING_OR_INVALID"]
      : []),
    ...(redis.status !== "ok" ? ["TRACKING_REDIS_UNAVAILABLE"] : []),
  ];
  return {
    ...configuration,
    redis: redis.status === "ok" ? "AVAILABLE" : "UNAVAILABLE",
    readyForTrackingWrites: blockers.length === 0,
    redirectAvailable: true,
    blockers,
  };
}

function hostAllowed(host: string, allowed: readonly string[]) {
  return allowed.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

export type DestinationValidation =
  | { ok: true; normalizedUrl: string; kind: "MARKETPLACE" | "INTERNAL" }
  | {
      ok: false;
      code:
        | "DESTINATION_MALFORMED"
        | "DESTINATION_HTTPS_REQUIRED"
        | "DESTINATION_CREDENTIALS_FORBIDDEN"
        | "DESTINATION_HOST_NOT_ALLOWED"
        | "DESTINATION_INTERNAL_LOOP";
    };

export function validateTrackingDestination(input: {
  destination: string;
  marketplace: TrackingMarketplace;
  env?: NodeJS.ProcessEnv;
  nodeEnv?: string;
}): DestinationValidation {
  const env = input.env ?? process.env;
  let url: URL;
  try {
    url = new URL(input.destination);
  } catch {
    return { ok: false, code: "DESTINATION_MALFORMED" };
  }
  if (url.username || url.password) {
    return { ok: false, code: "DESTINATION_CREDENTIALS_FORBIDDEN" };
  }
  const host = url.hostname.toLowerCase();
  const localHttpAllowed =
    (input.nodeEnv ?? env.NODE_ENV) !== "production" &&
    env.TRACKING_ALLOW_LOCAL_HTTP === "true" &&
    (host === "localhost" || host === "127.0.0.1" || host === "::1");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && localHttpAllowed)) {
    return { ok: false, code: "DESTINATION_HTTPS_REQUIRED" };
  }
  if (hostAllowed(host, DESTINATION_DOMAINS[input.marketplace])) {
    return { ok: true, normalizedUrl: url.toString(), kind: "MARKETPLACE" };
  }
  if (env.TRACKING_ALLOW_INTERNAL_REDIRECT === "true" && env.APP_BASE_URL) {
    try {
      const base = new URL(env.APP_BASE_URL);
      if (base.origin.toLowerCase() === url.origin.toLowerCase()) {
        if (url.pathname.startsWith("/go/")) {
          return { ok: false, code: "DESTINATION_INTERNAL_LOOP" };
        }
        return { ok: true, normalizedUrl: url.toString(), kind: "INTERNAL" };
      }
    } catch {
      // Invalid server configuration is treated as no internal allowlist.
    }
  }
  return { ok: false, code: "DESTINATION_HOST_NOT_ALLOWED" };
}

export function sanitizeRefererHost(value: string | null | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.hostname.toLowerCase().slice(0, 120) || null;
  } catch {
    return null;
  }
}

export type UserAgentCategory = "BOT" | "MOBILE" | "TABLET" | "DESKTOP" | "UNKNOWN";

export function classifyUserAgent(value: string | null | undefined): UserAgentCategory {
  if (!value) return "UNKNOWN";
  const normalized = value.toLowerCase().slice(0, 256);
  if (/bot|crawler|spider|preview|headless/.test(normalized)) return "BOT";
  if (/ipad|tablet/.test(normalized)) return "TABLET";
  if (/mobile|android|iphone/.test(normalized)) return "MOBILE";
  if (/mozilla|chrome|safari|firefox|edge|edg\//.test(normalized)) return "DESKTOP";
  return "UNKNOWN";
}

type HeaderReader = { get(name: string): string | null };

export function trustedClientAddress(headers: HeaderReader, env: NodeJS.ProcessEnv = process.env) {
  if (env.TRACKING_TRUST_PROXY_HEADERS !== "true") return null;
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const candidate = forwarded || headers.get("x-real-ip")?.trim() || null;
  return candidate && isIP(candidate) ? candidate : null;
}

function normalizedUserAgent(value: string | null | undefined) {
  return (value ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\x20-\x7e]/g, "")
    .trim()
    .slice(0, 160);
}

export type TemporaryFingerprint = {
  hash: string;
  windowStart: Date;
  windowSeconds: number;
};

export function createTemporaryFingerprint(input: {
  secret: string | undefined;
  clientAddress: string | null;
  userAgent: string | null;
  slug: string;
  now: Date;
  windowSeconds: number;
}): TemporaryFingerprint | null {
  if (!input.secret || input.secret.length < 32 || !input.clientAddress) return null;
  const windowMs = input.windowSeconds * 1_000;
  const windowStartMs = Math.floor(input.now.getTime() / windowMs) * windowMs;
  const payload = [
    "tfp1",
    input.clientAddress,
    normalizedUserAgent(input.userAgent),
    input.slug,
    String(windowStartMs),
  ].join("|");
  return {
    hash: createHmac("sha256", input.secret).update(payload).digest("hex"),
    windowStart: new Date(windowStartMs),
    windowSeconds: input.windowSeconds,
  };
}

export function redisSafeKeyPart(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

export function buildTrackingPath(slug: string) {
  return `/go/${encodeURIComponent(slug)}`;
}

export type ClickContext = {
  slug: string;
  channelId?: string;
  publicationId?: string;
  userAgent?: string;
  referer?: string;
};

export * from "./attribution";
export * from "./csv";
export * from "./import";
export * from "./analytics";
export * from "./status";
export * from "./sub-id";
