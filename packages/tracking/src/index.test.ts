import { describe, expect, it } from "vitest";
import {
  classifyUserAgent,
  createAttributionSubId,
  createTemporaryFingerprint,
  parseAttributionSubId,
  sanitizeRefererHost,
  trackingConfiguration,
  trackingPreflight,
  trustedClientAddress,
  validateTrackingDestination,
} from "./index";

const secret = "test-fingerprint-secret-with-32-characters";

describe("tracking destination validation", () => {
  it.each([
    ["MERCADO_LIVRE", "https://meli.la/fictitious"],
    ["MERCADO_LIVRE", "https://produto.mercadolivre.com.br/item"],
    ["SHOPEE", "https://shopee.com.br/product/fictitious"],
    ["SHOPEE", "https://s.shopee.com.br/fictitious"],
  ] as const)("accepts a known HTTPS destination for %s", (marketplace, destination) => {
    expect(validateTrackingDestination({ marketplace, destination })).toMatchObject({ ok: true });
  });

  it.each([
    "http://meli.la/fictitious",
    "javascript:alert(1)",
    "https://meli.la.evil.example/fictitious",
    "https://evilmercadolivre.com.br/fictitious",
    "https://user:password@meli.la/fictitious",
  ])("blocks unsafe destination %s", (destination) => {
    expect(validateTrackingDestination({ marketplace: "MERCADO_LIVRE", destination }).ok).toBe(false);
  });

  it("allows local HTTP only outside production with an explicit flag", () => {
    expect(validateTrackingDestination({
      marketplace: "MERCADO_LIVRE",
      destination: "http://localhost:3000/fixture",
      nodeEnv: "test",
      env: { TRACKING_ALLOW_LOCAL_HTTP: "true", TRACKING_ALLOW_INTERNAL_REDIRECT: "true", APP_BASE_URL: "http://localhost:3000" },
    })).toMatchObject({ ok: true, kind: "INTERNAL" });
    expect(validateTrackingDestination({
      marketplace: "MERCADO_LIVRE",
      destination: "http://localhost:3000/fixture",
      nodeEnv: "production",
      env: { TRACKING_ALLOW_LOCAL_HTTP: "true", TRACKING_ALLOW_INTERNAL_REDIRECT: "true", APP_BASE_URL: "http://localhost:3000" },
    }).ok).toBe(false);
  });

  it("blocks an internal tracking loop", () => {
    expect(validateTrackingDestination({
      marketplace: "MERCADO_LIVRE",
      destination: "https://app.example/go/repeat",
      env: { TRACKING_ALLOW_INTERNAL_REDIRECT: "true", APP_BASE_URL: "https://app.example" },
    })).toMatchObject({ ok: false, code: "DESTINATION_INTERNAL_LOOP" });
  });

  it("requires the exact configured origin for internal redirects", () => {
    expect(validateTrackingDestination({
      marketplace: "MERCADO_LIVRE",
      destination: "https://app.example:9443/safe",
      env: { TRACKING_ALLOW_INTERNAL_REDIRECT: "true", APP_BASE_URL: "https://app.example:8443" },
    })).toMatchObject({ ok: false, code: "DESTINATION_HOST_NOT_ALLOWED" });
  });
});

describe("privacy helpers", () => {
  it("keeps only the referer hostname and removes query and fragment", () => {
    expect(sanitizeRefererHost("https://example.test/private?token=secret#fragment")).toBe("example.test");
    expect(sanitizeRefererHost("not-a-url")).toBeNull();
  });

  it("stores only a coarse user-agent category", () => {
    expect(classifyUserAgent("Mozilla/5.0 (iPhone) private-detail")).toBe("MOBILE");
    expect(classifyUserAgent("SearchBot/1.0")).toBe("BOT");
    expect(classifyUserAgent(null)).toBe("UNKNOWN");
  });

  it("trusts proxy addresses only with explicit configuration", () => {
    const headers = { get: (name: string) => name === "x-forwarded-for" ? "203.0.113.8, 10.0.0.1" : null };
    expect(trustedClientAddress(headers, {})).toBeNull();
    expect(trustedClientAddress(headers, { TRACKING_TRUST_PROXY_HEADERS: "true" })).toBe("203.0.113.8");
  });

  it("creates a temporary irreversible fingerprint that changes after the window", () => {
    const first = createTemporaryFingerprint({ secret, clientAddress: "203.0.113.8", userAgent: "fixture", slug: "safe", now: new Date("2026-08-05T10:00:01Z"), windowSeconds: 30 });
    const sameWindow = createTemporaryFingerprint({ secret, clientAddress: "203.0.113.8", userAgent: "fixture", slug: "safe", now: new Date("2026-08-05T10:00:29Z"), windowSeconds: 30 });
    const nextWindow = createTemporaryFingerprint({ secret, clientAddress: "203.0.113.8", userAgent: "fixture", slug: "safe", now: new Date("2026-08-05T10:00:31Z"), windowSeconds: 30 });
    expect(first?.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(first?.hash).toBe(sameWindow?.hash);
    expect(nextWindow?.hash).not.toBe(first?.hash);
    expect(JSON.stringify(first)).not.toContain("203.0.113.8");
  });

  it("fails closed for missing or invalid fingerprint secrets and addresses", () => {
    const base = { clientAddress: "203.0.113.8", userAgent: "fixture", slug: "safe", now: new Date(), windowSeconds: 30 };
    expect(createTemporaryFingerprint({ ...base, secret: "short" })).toBeNull();
    expect(createTemporaryFingerprint({ ...base, secret, clientAddress: null })).toBeNull();
  });
});

describe("tracking configuration and Sub IDs", () => {
  it("uses safe bounded defaults for invalid values", () => {
    expect(trackingConfiguration({ TRACKING_RATE_LIMIT_PER_CLIENT_PER_MINUTE: "-1" })).toMatchObject({
      rateLimitPerClientPerMinute: 30,
      rateLimitPerSlugPerMinute: 300,
      dedupWindowSeconds: 30,
      state: "DEGRADED_MISSING_FINGERPRINT_SECRET",
    });
  });

  it("reports missing secret or Redis without disabling valid redirects", async () => {
    await expect(trackingPreflight({}, { redisHealth: async () => ({ mode: "unavailable", status: "unavailable" }) })).resolves.toMatchObject({
      readyForTrackingWrites: false,
      redirectAvailable: true,
      blockers: expect.arrayContaining(["TRACKING_FINGERPRINT_SECRET_MISSING_OR_INVALID", "TRACKING_REDIS_UNAVAILABLE"]),
    });
  });

  it("generates deterministic versioned Sub IDs without raw identifiers", () => {
    const input = { secret, marketplace: "MERCADO_LIVRE" as const, channelId: "private-channel-name", publicationId: "publication-fictitious-001" };
    const value = createAttributionSubId(input);
    expect(value).toBe(createAttributionSubId(input));
    expect(value).toMatch(/^aa1_ml_/);
    expect(value).not.toContain(input.channelId);
    expect(value).not.toContain(input.publicationId);
    expect(parseAttributionSubId(value, secret)).toMatchObject({ ok: true, marketplace: "MERCADO_LIVRE" });
  });

  it("rejects malformed, tampered and wrong-secret Sub IDs", () => {
    const value = createAttributionSubId({ secret, marketplace: "SHOPEE", channelId: "channel", publicationId: "publication" });
    expect(parseAttributionSubId("invalid", secret)).toMatchObject({ ok: false });
    expect(parseAttributionSubId(`${value.slice(0, -1)}x`, secret)).toMatchObject({ ok: false, code: "SUB_ID_CHECKSUM_INVALID" });
    expect(parseAttributionSubId(value, "another-test-secret-with-32-characters")).toMatchObject({ ok: false });
  });
});
