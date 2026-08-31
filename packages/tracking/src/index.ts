import { createHash, createHmac } from "node:crypto";
import { isIP } from "node:net";
import { getRedisHealth } from "@affiliate/redis";

export type TrackingMarketplace = "MERCADO_LIVRE" | "SHOPEE";

const DESTINATION_DOMAINS: Record<TrackingMarketplace, readonly string[]> = {
  MERCADO_LIVRE: ["meli.la", "mercadolivre.com.br", "mercadolibre.com"],
  SHOPEE: ["s.shopee.com.br"],
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
  const publicTracking = resolvePublicTrackingReadiness(env);
  const redis = await (dependencies.redisHealth ?? getRedisHealth)();
  const blockers = [
    ...(!configuration.enabled ? ["TRACKING_DISABLED"] : []),
    ...(!configuration.fingerprintSecretConfigured
      ? ["TRACKING_FINGERPRINT_SECRET_MISSING_OR_INVALID"]
      : []),
    ...(redis.status !== "ok" ? ["TRACKING_REDIS_UNAVAILABLE"] : []),
    ...(publicTracking.mode === "LIVE" && !publicTracking.ready
      ? [publicTracking.reason ?? "PUBLIC_TRACKING_NOT_READY"]
      : []),
  ];
  return {
    ...configuration,
    redis: redis.status === "ok" ? "AVAILABLE" : "UNAVAILABLE",
    readyForTrackingWrites: blockers.length === 0,
    redirectAvailable: true,
    publicTracking,
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

export type ProductionAutonomyMode = "OFF" | "READY" | "LIVE";

export type PublicTrackingReadiness = {
  mode: ProductionAutonomyMode;
  configured: boolean;
  stableRequired: boolean;
  ready: boolean;
  baseUrl: string | null;
  reason:
    | null
    | "PUBLIC_TRACKING_BASE_URL_MISSING"
    | "PUBLIC_TRACKING_BASE_URL_INVALID"
    | "PUBLIC_TRACKING_HTTPS_REQUIRED"
    | "PUBLIC_TRACKING_CREDENTIALS_FORBIDDEN"
    | "PUBLIC_TRACKING_HOST_NOT_PUBLIC"
    | "PUBLIC_TRACKING_TEMPORARY_HOST_FORBIDDEN"
    | "PUBLIC_TRACKING_BASE_PATH_INVALID";
};

function productionAutonomyMode(value: string | undefined): ProductionAutonomyMode {
  return value === "READY" || value === "LIVE" ? value : "OFF";
}

function publicTrackingHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    !host ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local")
  ) {
    return false;
  }
  if (isIP(host) === 4) {
    const parts = host.split(".").map(Number);
    const [first, second, third] = parts;
    return !(
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second !== undefined && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 192 && second === 0 && (third === 0 || third === 2)) ||
      (first === 198 && (second === 18 || second === 19)) ||
      (first === 198 && second === 51 && third === 100) ||
      (first === 203 && second === 0 && third === 113) ||
      (first !== undefined && first >= 224)
    );
  }
  if (isIP(host) === 6) {
    return !(
      host === "::" ||
      host === "::1" ||
      host.startsWith("fc") ||
      host.startsWith("fd") ||
      /^fe[89ab]/u.test(host)
    );
  }
  return host.includes(".");
}

export function resolvePublicTrackingReadiness(
  env: NodeJS.ProcessEnv = process.env,
): PublicTrackingReadiness {
  const mode = productionAutonomyMode(env.PRODUCTION_AUTONOMY_MODE);
  const stableRequired =
    mode === "LIVE" || env.PUBLIC_TRACKING_REQUIRE_STABLE_URL !== "false";
  const configuredValue = env.PUBLIC_TRACKING_BASE_URL?.trim() || null;
  if (!configuredValue) {
    const developmentFallback =
      mode !== "LIVE"
        ? env.APP_BASE_URL?.trim() || env.NEXT_PUBLIC_APP_URL?.trim() || null
        : null;
    if (developmentFallback && !stableRequired) {
      try {
        const url = new URL(developmentFallback);
        if (
          (url.protocol !== "http:" && url.protocol !== "https:") ||
          url.username ||
          url.password
        ) {
          throw new Error("PUBLIC_TRACKING_DEVELOPMENT_FALLBACK_INVALID");
        }
        return {
          mode,
          configured: false,
          stableRequired,
          ready: true,
          baseUrl: url.origin,
          reason: null,
        };
      } catch {
        // Fall through to the fail-closed result.
      }
    }
    return {
      mode,
      configured: false,
      stableRequired,
      ready: mode === "OFF",
      baseUrl: null,
      reason: "PUBLIC_TRACKING_BASE_URL_MISSING",
    };
  }
  let url: URL;
  try {
    url = new URL(configuredValue);
  } catch {
    return {
      mode,
      configured: true,
      stableRequired,
      ready: false,
      baseUrl: null,
      reason: "PUBLIC_TRACKING_BASE_URL_INVALID",
    };
  }
  let reason: PublicTrackingReadiness["reason"] = null;
  if (url.protocol !== "https:") reason = "PUBLIC_TRACKING_HTTPS_REQUIRED";
  else if (url.username || url.password)
    reason = "PUBLIC_TRACKING_CREDENTIALS_FORBIDDEN";
  else if (!publicTrackingHost(url.hostname))
    reason = "PUBLIC_TRACKING_HOST_NOT_PUBLIC";
  else if (
    url.hostname.toLowerCase() === "trycloudflare.com" ||
    url.hostname.toLowerCase().endsWith(".trycloudflare.com")
  ) {
    reason = "PUBLIC_TRACKING_TEMPORARY_HOST_FORBIDDEN";
  } else if (
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    reason = "PUBLIC_TRACKING_BASE_PATH_INVALID";
  }
  return {
    mode,
    configured: true,
    stableRequired,
    ready: reason === null,
    baseUrl: reason === null ? url.origin : null,
    reason,
  };
}

export function buildPublicTrackingUrl(
  slug: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const readiness = resolvePublicTrackingReadiness(env);
  if (!readiness.ready || !readiness.baseUrl) {
    throw new Error(readiness.reason ?? "PUBLIC_TRACKING_NOT_READY");
  }
  return `${readiness.baseUrl}${buildTrackingPath(slug)}`;
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
