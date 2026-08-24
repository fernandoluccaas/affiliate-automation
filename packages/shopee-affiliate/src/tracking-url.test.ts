import { describe, expect, it } from "vitest";
import {
  resolveShopeePublicTrackingReadiness,
  validatePublicShopeeTrackingUrl,
} from "./tracking-url";

describe("public Shopee tracking URL", () => {
  it.each([
    "https://affiliate.example.com/go/publication-1",
    "https://8.8.8.8/go/publication-1",
  ])("accepts a public absolute HTTPS /go URL: %s", (url) => {
    expect(validatePublicShopeeTrackingUrl(url)).toMatchObject({ ok: true });
  });

  it.each([
    "http://affiliate.example.com/go/publication-1",
    "/go/publication-1",
    "https://localhost/go/publication-1",
    "https://app.local/go/publication-1",
    "https://127.0.0.1/go/publication-1",
    "https://127.20.30.40/go/publication-1",
    "https://0.0.0.0/go/publication-1",
    "https://10.0.0.1/go/publication-1",
    "https://172.16.0.1/go/publication-1",
    "https://172.31.255.255/go/publication-1",
    "https://192.168.1.1/go/publication-1",
    "https://169.254.1.1/go/publication-1",
    "https://100.64.0.1/go/publication-1",
    "https://203.0.113.10/go/publication-1",
    "https://[::1]/go/publication-1",
    "https://[fc00::1]/go/publication-1",
    "https://[fd00::1]/go/publication-1",
    "https://[fe80::1]/go/publication-1",
    "https://affiliate.example.com/not-go/publication-1",
    "https://user:secret@affiliate.example.com/go/publication-1",
  ])("rejects a non-public tracking target: %s", (url) => {
    expect(validatePublicShopeeTrackingUrl(url)).toMatchObject({
      ok: false,
      code: "SHOPEE_TRACKING_URL_NOT_PUBLIC_HTTPS",
    });
  });

  it("keeps localhost usable locally but not externally ready", () => {
    expect(
      resolveShopeePublicTrackingReadiness({
        APP_BASE_URL: "http://localhost:3000",
      }),
    ).toEqual({
      ready: false,
      configured: true,
      localBaseUrl: "http://localhost:3000",
      reason: "NOT_HTTPS",
    });
  });
});
