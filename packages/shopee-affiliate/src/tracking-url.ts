import { isIP } from "node:net";

export const SHOPEE_TRACKING_URL_NOT_PUBLIC_HTTPS =
  "SHOPEE_TRACKING_URL_NOT_PUBLIC_HTTPS" as const;

export type PublicTrackingUrlValidationResult =
  | { ok: true; normalizedUrl: string }
  | {
      ok: false;
      code: typeof SHOPEE_TRACKING_URL_NOT_PUBLIC_HTTPS;
      reason:
        | "NOT_ABSOLUTE"
        | "NOT_HTTPS"
        | "CREDENTIALS_NOT_ALLOWED"
        | "PRIVATE_HOST"
        | "INVALID_TRACKING_PATH";
    };

function parseIpv4(hostname: string) {
  const parts = hostname.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map(Number);
  return octets.every(
    (octet, index) =>
      /^\d+$/.test(parts[index] ?? "") &&
      Number.isInteger(octet) &&
      octet >= 0 &&
      octet <= 255,
  )
    ? octets
    : null;
}

function isPrivateIpv4(hostname: string) {
  const octets = parseIpv4(hostname);
  if (!octets) return false;
  const [first, second, third] = octets;
  return (
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

function isPrivateIpv6(hostname: string) {
  if (isIP(hostname) !== 6) return false;
  const lower = hostname.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  if (/^f[cd][0-9a-f]{0,2}:/u.test(lower)) return true;
  if (/^fe[89ab][0-9a-f]?:/u.test(lower)) return true;
  if (lower.startsWith("ff") || lower.startsWith("2001:db8:")) return true;
  const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/u)?.[1];
  return mapped ? isPrivateIpv4(mapped) : false;
}

export function isPublicHostname(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    !normalized ||
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local")
  ) {
    return false;
  }
  if (isIP(normalized) === 4) return !isPrivateIpv4(normalized);
  if (isIP(normalized) === 6) return !isPrivateIpv6(normalized);
  return true;
}

export function validatePublicShopeeTrackingUrl(
  value: string,
): PublicTrackingUrlValidationResult {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return {
      ok: false,
      code: SHOPEE_TRACKING_URL_NOT_PUBLIC_HTTPS,
      reason: "NOT_ABSOLUTE",
    };
  }
  if (url.protocol !== "https:") {
    return {
      ok: false,
      code: SHOPEE_TRACKING_URL_NOT_PUBLIC_HTTPS,
      reason: "NOT_HTTPS",
    };
  }
  if (url.username || url.password) {
    return {
      ok: false,
      code: SHOPEE_TRACKING_URL_NOT_PUBLIC_HTTPS,
      reason: "CREDENTIALS_NOT_ALLOWED",
    };
  }
  if (!isPublicHostname(url.hostname)) {
    return {
      ok: false,
      code: SHOPEE_TRACKING_URL_NOT_PUBLIC_HTTPS,
      reason: "PRIVATE_HOST",
    };
  }
  if (!/^\/go\/[^/]+$/u.test(url.pathname)) {
    return {
      ok: false,
      code: SHOPEE_TRACKING_URL_NOT_PUBLIC_HTTPS,
      reason: "INVALID_TRACKING_PATH",
    };
  }
  return { ok: true, normalizedUrl: url.toString() };
}

export function resolveShopeePublicTrackingReadiness(
  environment: NodeJS.ProcessEnv,
) {
  const configuredBaseUrl =
    environment.APP_BASE_URL ?? environment.NEXT_PUBLIC_APP_URL ?? null;
  const localBaseUrl = (configuredBaseUrl ?? "http://localhost:3000").replace(
    /\/$/u,
    "",
  );
  const validation = validatePublicShopeeTrackingUrl(
    `${localBaseUrl}/go/readiness-check`,
  );
  return {
    ready: validation.ok,
    configured: configuredBaseUrl !== null,
    localBaseUrl,
    reason: validation.ok ? null : validation.reason,
  };
}
