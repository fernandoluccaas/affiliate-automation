import { describe, expect, it, vi } from "vitest";
import {
  MercadoLivreAffiliateSessionService,
  getMercadoLivreSetCookieHeaders,
  type MercadoLivreAffiliateFetch,
} from "./affiliate-session";

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

describe("MercadoLivreAffiliateSessionService", () => {
  it("warms only the Link Builder, reads tags and propagates refreshed cookies", async () => {
    const fetchFn = vi
      .fn<MercadoLivreAffiliateFetch>()
      .mockResolvedValueOnce(
        response(null, {
          setCookies: [
            "sid=warm; Path=/; Secure",
            "_csrf=warm%20token; Path=/; Secure",
          ],
        }),
      )
      .mockResolvedValueOnce(
        response(
          {
            data: {
              tags: [
                { tag: "secondary", label: "Secondary" },
                {
                  tag: "default-tag",
                  label: "Default",
                  is_default: true,
                },
              ],
            },
          },
          {
            setCookies: [
              "sid=final; Path=/; Secure",
              "_csrf=tags%20token; Path=/; Secure",
            ],
          },
        ),
      );
    const service = new MercadoLivreAffiliateSessionService({
      fetchFn,
    });

    const result = await service.validateSession({
      cookie: "sid=old; keep=value",
    });

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls[0]?.[0]).toBe(
      "https://www.mercadolivre.com.br/afiliados/linkbuilder",
    );
    expect(fetchFn.mock.calls[1]?.[0]).toBe(
      "https://www.mercadolivre.com.br/affiliate-program/api/v2/stripe/user/tags",
    );
    const tagsRequest = fetchFn.mock.calls[1]?.[1];
    const tagsHeaders = new Headers(tagsRequest?.headers);
    expect(tagsHeaders.get("Cookie")).toContain("sid=warm");
    expect(tagsHeaders.get("X-CSRF-Token")).toBe("warm token");
    expect(tagsRequest?.redirect).toBe("manual");
    expect(result.cookie).toContain("sid=final");
    expect(result.cookie).toContain("keep=value");
    expect(result.cookie).toContain("_csrf=tags%20token");
    expect(result.csrfToken).toBe("tags token");
    expect(result.selectedTag?.value).toBe("default-tag");
    expect(result.tags).toHaveLength(2);
  });

  it("preserves a valid preferred tag", async () => {
    const fetchFn = vi
      .fn<MercadoLivreAffiliateFetch>()
      .mockResolvedValueOnce(response(null))
      .mockResolvedValueOnce(response(["first", "preferred"]));
    const service = new MercadoLivreAffiliateSessionService({
      fetchFn,
    });

    const result = await service.validateSession({
      cookie: "sid=value; _csrf=token",
      preferredTag: "preferred",
    });

    expect(result.selectedTag?.value).toBe("preferred");
  });

  it("uses safe defaults when optional HTTP environment values are empty", async () => {
    const fetchFn = vi
      .fn<MercadoLivreAffiliateFetch>()
      .mockResolvedValueOnce(response(null))
      .mockResolvedValueOnce(response(["tag"]));
    const service = new MercadoLivreAffiliateSessionService({
      fetchFn,
      env: {
        MERCADOLIVRE_AFFILIATE_BASE_URL: "",
        MERCADOLIVRE_AFFILIATE_REFERER: "",
        MERCADOLIVRE_AFFILIATE_USER_AGENT: "",
      },
    });

    await service.validateSession({
      cookie: "sid=value; _csrf=token",
    });

    expect(fetchFn.mock.calls[0]?.[0]).toBe(
      "https://www.mercadolivre.com.br/afiliados/linkbuilder",
    );
    expect(fetchFn.mock.calls[1]?.[0]).toBe(
      "https://www.mercadolivre.com.br/affiliate-program/api/v2/stripe/user/tags",
    );
    expect(
      new Headers(fetchFn.mock.calls[0]?.[1]?.headers).get("User-Agent"),
    ).toContain("Mozilla/5.0");
  });

  it("performs one additional warmup and tags retry after HTTP 403", async () => {
    const fetchFn = vi
      .fn<MercadoLivreAffiliateFetch>()
      .mockResolvedValueOnce(response(null))
      .mockResolvedValueOnce(response({ error: "forbidden" }, { status: 403 }))
      .mockResolvedValueOnce(
        response(null, {
          setCookies: ["_csrf=refreshed; Path=/; Secure"],
        }),
      )
      .mockResolvedValueOnce(response(["tag"]));
    const service = new MercadoLivreAffiliateSessionService({
      fetchFn,
    });

    const result = await service.validateSession({
      cookie: "sid=value; _csrf=old",
    });

    expect(fetchFn).toHaveBeenCalledTimes(4);
    expect(fetchFn.mock.calls[2]?.[0]).toBe(
      "https://www.mercadolivre.com.br/afiliados/linkbuilder",
    );
    expect(
      new Headers(fetchFn.mock.calls[3]?.[1]?.headers).get("X-CSRF-Token"),
    ).toBe("refreshed");
    expect(result.selectedTag?.value).toBe("tag");
  });

  it("classifies a redirect to login as an expired affiliate session", async () => {
    const fetchFn = vi.fn<MercadoLivreAffiliateFetch>().mockResolvedValueOnce(
      response(null, {
        status: 302,
        location: "https://www.mercadolivre.com.br/jms/mlb/lgz/login",
      }),
    );
    const service = new MercadoLivreAffiliateSessionService({
      fetchFn,
    });

    const error = await service
      .validateSession({ cookie: "sid=value" })
      .catch((value: unknown) => value);

    expect(error).toMatchObject({
      name: "MercadoLivreAffiliateApiError",
      stage: "SESSION_WARMUP",
      code: "LOGIN_REDIRECT",
      sessionExpired: true,
      retryable: false,
    });
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("retries 429 and 5xx with bounded backoff", async () => {
    const fetchFn = vi
      .fn<MercadoLivreAffiliateFetch>()
      .mockResolvedValueOnce(response({}, { status: 429 }))
      .mockResolvedValueOnce(response({}, { status: 503 }))
      .mockResolvedValueOnce(response(null))
      .mockResolvedValueOnce(response(["tag"]));
    const sleep = vi.fn(async () => undefined);
    const service = new MercadoLivreAffiliateSessionService({
      fetchFn,
      sleep,
      random: () => 0,
      backoffBaseMs: 10,
      maxAttempts: 3,
    });

    await expect(
      service.validateSession({
        cookie: "sid=value; _csrf=token",
      }),
    ).resolves.toMatchObject({
      selectedTag: { value: "tag" },
    });
    expect(sleep).toHaveBeenNthCalledWith(1, 10);
    expect(sleep).toHaveBeenNthCalledWith(2, 20);
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  it("supports runtimes without Headers.getSetCookie", () => {
    const headers = {
      get: (name: string) =>
        name.toLowerCase() === "set-cookie"
          ? "first=1; Expires=Wed, 21 Oct 2099 07:28:00 GMT, second=2; Path=/"
          : null,
    } as unknown as Headers;

    expect(getMercadoLivreSetCookieHeaders(headers)).toEqual([
      "first=1; Expires=Wed, 21 Oct 2099 07:28:00 GMT",
      "second=2; Path=/",
    ]);
  });
});
