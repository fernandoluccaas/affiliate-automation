import { describe, expect, it, vi } from "vitest";
import {
  MercadoLivreAffiliateLinkService,
  normalizeMercadoLivreAffiliateProductUrl,
  normalizeMercadoLivreGeneratedAffiliateUrl,
} from "./affiliate-link";
import type { MercadoLivreAffiliateFetch } from "./affiliate-session";

function response(
  body: unknown,
  options: {
    status?: number;
    setCookies?: string[];
    location?: string;
  } = {},
) {
  const headers = new Headers();

  if (body !== null) {
    headers.set("Content-Type", "application/json");
  }

  for (const cookie of options.setCookies ?? []) {
    headers.append("Set-Cookie", cookie);
  }

  if (options.location) {
    headers.set("Location", options.location);
  }

  return new Response(body === null ? null : JSON.stringify(body), {
    status: options.status ?? 200,
    headers,
  });
}

const validInput = {
  productUrl: "https://produto.mercadolivre.com.br/MLB-1234567890",
  affiliateTag: "my-tag",
  cookie: "sid=old; _csrf=old%20csrf",
  csrfToken: "old csrf",
};

describe("MercadoLivreAffiliateLinkService", () => {
  it("always warms the Link Builder before posting and returns a valid refreshed meli.la URL", async () => {
    const fetchFn = vi
      .fn<MercadoLivreAffiliateFetch>()
      .mockResolvedValueOnce(
        response(null, {
          setCookies: [
            "sid=warmed; Path=/; Secure",
            "_csrf=warmed%20csrf; Path=/; Secure",
          ],
        }),
      )
      .mockResolvedValueOnce(
        response(
          { short_url: "https://meli.la/AbC123" },
          {
            setCookies: [
              "sid=final; Path=/; Secure",
              "_csrf=final%20csrf; Path=/; Secure",
            ],
          },
        ),
      );
    const service = new MercadoLivreAffiliateLinkService({
      fetchFn,
    });

    const result = await service.create(validInput);

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls[0]?.[0]).toBe(
      "https://www.mercadolivre.com.br/afiliados/linkbuilder",
    );
    expect(fetchFn.mock.calls[1]?.[0]).toBe(
      "https://www.mercadolivre.com.br/affiliate-program/api/v2/stripe/user/links",
    );
    const postInit = fetchFn.mock.calls[1]?.[1];
    const postHeaders = new Headers(postInit?.headers);
    expect(postInit?.method).toBe("POST");
    expect(postInit?.redirect).toBe("manual");
    expect(postHeaders.get("Accept")).toBe("application/json, text/plain, */*");
    expect(postHeaders.get("Content-Type")).toBe("application/json");
    expect(postHeaders.get("Origin")).toBe("https://www.mercadolivre.com.br");
    expect(postHeaders.get("Referer")).toBe(
      "https://www.mercadolivre.com.br/afiliados/linkbuilder",
    );
    expect(postHeaders.get("Cookie")).toContain("sid=warmed");
    expect(postHeaders.get("X-CSRF-Token")).toBe("warmed csrf");
    expect(JSON.parse(String(postInit?.body))).toEqual({
      url: validInput.productUrl,
      tag: "my-tag",
    });
    expect(result).toEqual({
      affiliateUrl: "https://meli.la/AbC123",
      refreshedCookie: "sid=final; _csrf=final%20csrf",
      refreshedCsrfToken: "final csrf",
    });
  });

  it("classifies code 111 from an HTTP 200 body as product ineligible", async () => {
    const fetchFn = vi
      .fn<MercadoLivreAffiliateFetch>()
      .mockResolvedValueOnce(response(null))
      .mockResolvedValueOnce(
        response({
          code: 111,
          message: "Product is not eligible",
        }),
      );
    const service = new MercadoLivreAffiliateLinkService({
      fetchFn,
    });

    const error = await service
      .create(validInput)
      .catch((value: unknown) => value);

    expect(error).toMatchObject({
      name: "MercadoLivreAffiliateApiError",
      stage: "LINK_GENERATION",
      status: 200,
      code: 111,
      productIneligible: true,
      retryable: false,
      sessionExpired: false,
    });
  });

  it("rejects a successful response without short_url", async () => {
    const fetchFn = vi
      .fn<MercadoLivreAffiliateFetch>()
      .mockResolvedValueOnce(response(null))
      .mockResolvedValueOnce(response({ ok: true }));
    const service = new MercadoLivreAffiliateLinkService({
      fetchFn,
    });

    await expect(service.create(validInput)).rejects.toMatchObject({
      stage: "RESPONSE_PARSING",
      code: "MISSING_SHORT_URL",
    });
  });

  it("performs exactly one warmup/retry after link HTTP 403", async () => {
    const fetchFn = vi
      .fn<MercadoLivreAffiliateFetch>()
      .mockResolvedValueOnce(response(null))
      .mockResolvedValueOnce(response({ error: "csrf" }, { status: 403 }))
      .mockResolvedValueOnce(
        response(null, {
          setCookies: ["_csrf=new%20csrf; Path=/; Secure"],
        }),
      )
      .mockResolvedValueOnce(
        response({ short_url: "https://meli.la/retried" }),
      );
    const service = new MercadoLivreAffiliateLinkService({
      fetchFn,
      maxAttempts: 3,
    });

    await expect(service.create(validInput)).resolves.toMatchObject({
      affiliateUrl: "https://meli.la/retried",
      refreshedCsrfToken: "new csrf",
    });
    expect(fetchFn).toHaveBeenCalledTimes(4);
    expect(fetchFn.mock.calls[2]?.[0]).toBe(
      "https://www.mercadolivre.com.br/afiliados/linkbuilder",
    );
    expect(
      new Headers(fetchFn.mock.calls[3]?.[1]?.headers).get("X-CSRF-Token"),
    ).toBe("new csrf");
  });

  it("does not repeat the 403 warmup indefinitely", async () => {
    const fetchFn = vi
      .fn<MercadoLivreAffiliateFetch>()
      .mockResolvedValueOnce(response(null))
      .mockResolvedValueOnce(response({}, { status: 403 }))
      .mockResolvedValueOnce(response(null))
      .mockResolvedValueOnce(response({}, { status: 403 }));
    const service = new MercadoLivreAffiliateLinkService({
      fetchFn,
      maxAttempts: 3,
    });

    await expect(service.create(validInput)).rejects.toMatchObject({
      status: 403,
      sessionExpired: true,
      retryable: false,
    });
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  it("retries transient link responses at most three times", async () => {
    const fetchFn = vi
      .fn<MercadoLivreAffiliateFetch>()
      .mockResolvedValueOnce(response(null))
      .mockResolvedValueOnce(response({}, { status: 429 }))
      .mockResolvedValueOnce(response({}, { status: 503 }))
      .mockResolvedValueOnce(
        response({ short_url: "https://meli.la/success" }),
      );
    const sleep = vi.fn(async () => undefined);
    const service = new MercadoLivreAffiliateLinkService({
      fetchFn,
      sleep,
      random: () => 0,
      backoffBaseMs: 25,
      maxAttempts: 3,
    });

    await expect(service.create(validInput)).resolves.toMatchObject({
      affiliateUrl: "https://meli.la/success",
    });
    expect(sleep).toHaveBeenNthCalledWith(1, 25);
    expect(sleep).toHaveBeenNthCalledWith(2, 50);
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  it("retries network failures and returns a sanitized typed error", async () => {
    const secretCookie = "sid=secret-cookie-value";
    const fetchFn = vi
      .fn<MercadoLivreAffiliateFetch>()
      .mockResolvedValueOnce(response(null))
      .mockRejectedValueOnce(new Error(`Cookie: ${secretCookie}`))
      .mockRejectedValueOnce(new Error("network failed"))
      .mockRejectedValueOnce(new Error("network failed"));
    const service = new MercadoLivreAffiliateLinkService({
      fetchFn,
      sleep: async () => undefined,
      random: () => 0,
      maxAttempts: 3,
    });

    const error = await service
      .create({
        ...validInput,
        cookie: secretCookie,
      })
      .catch((value: unknown) => value);

    expect(error).toMatchObject({
      stage: "LINK_GENERATION",
      code: "NETWORK_OR_TIMEOUT",
      attempts: 3,
      retryable: true,
      sessionExpired: false,
    });
    expect(String((error as Error).message)).not.toContain(
      "secret-cookie-value",
    );
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  it("classifies 401 and login redirects as expired", async () => {
    const unauthorizedFetch = vi
      .fn<MercadoLivreAffiliateFetch>()
      .mockResolvedValueOnce(response(null))
      .mockResolvedValueOnce(
        response({ error: "unauthorized" }, { status: 401 }),
      );
    const redirectedFetch = vi
      .fn<MercadoLivreAffiliateFetch>()
      .mockResolvedValueOnce(response(null))
      .mockResolvedValueOnce(
        response(null, {
          status: 302,
          location: "https://www.mercadolivre.com.br/jms/mlb/lgz/login",
        }),
      );

    await expect(
      new MercadoLivreAffiliateLinkService({
        fetchFn: unauthorizedFetch,
      }).create(validInput),
    ).rejects.toMatchObject({
      status: 401,
      sessionExpired: true,
    });
    await expect(
      new MercadoLivreAffiliateLinkService({
        fetchFn: redirectedFetch,
      }).create(validInput),
    ).rejects.toMatchObject({
      status: 302,
      code: "LOGIN_REDIRECT",
      sessionExpired: true,
    });
  });
});

describe("Mercado Livre affiliate URL allowlists", () => {
  it.each([
    "https://produto.mercadolivre.com.br/MLB-1",
    "https://www.mercadolivre.com.br/item/MLB-1",
    "https://produto.mercadolibre.com/MLB-1",
  ])("accepts product URL %s", (url) => {
    expect(normalizeMercadoLivreAffiliateProductUrl(url)).toBe(url);
  });

  it.each([
    "http://produto.mercadolivre.com.br/MLB-1",
    "https://evilmercadolivre.com.br/MLB-1",
    "https://mercadolivre.com.br.evil.example/MLB-1",
    "https://example.com/MLB-1",
  ])("rejects product URL %s", (url) => {
    expect(() => normalizeMercadoLivreAffiliateProductUrl(url)).toThrow();
  });

  it.each([
    "https://meli.la/AbC",
    "https://www.mercadolivre.com.br/affiliate/AbC",
    "https://mercadolibre.com/affiliate/AbC",
  ])("accepts generated URL %s", (url) => {
    expect(normalizeMercadoLivreGeneratedAffiliateUrl(url)).toBe(url);
  });

  it.each([
    "http://meli.la/AbC",
    "https://meli.la.evil.example/AbC",
    "https://example.com/AbC",
  ])("rejects generated URL %s", (url) => {
    expect(() => normalizeMercadoLivreGeneratedAffiliateUrl(url)).toThrow();
  });
});
