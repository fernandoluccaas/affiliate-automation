import {
  extractMercadoLivreCsrfToken,
  mergeMercadoLivreCookies,
  normalizeMercadoLivreCookie,
} from "./affiliate-cookie";
import { MercadoLivreAffiliateApiError } from "./affiliate-errors";
import {
  MercadoLivreAffiliateHttpRuntime,
  MercadoLivreAffiliateSessionService,
  getMercadoLivreSetCookieHeaders,
  isMercadoLivreAffiliateLoginRedirect,
  type MercadoLivreAffiliateHttpOptions,
} from "./affiliate-session";
import type {
  CreateMercadoLivreAffiliateLinkInput,
  CreateMercadoLivreAffiliateLinkResult,
} from "./affiliate-types";

const PRODUCT_DOMAINS = ["mercadolivre.com.br", "mercadolibre.com"] as const;
const AFFILIATE_DOMAINS = [
  "meli.la",
  "mercadolivre.com.br",
  "mercadolibre.com",
] as const;

function hostnameMatchesDomain(hostname: string, domain: string) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function isAllowedHostname(hostname: string, domains: readonly string[]) {
  const normalized = hostname.toLowerCase();
  return domains.some((domain) => hostnameMatchesDomain(normalized, domain));
}

function normalizeAllowedUrl(
  value: string,
  domains: readonly string[],
  code: string,
  description: string,
) {
  let url: URL;

  try {
    url = new URL(value.trim());
  } catch {
    throw new MercadoLivreAffiliateApiError(`${description} is invalid.`, {
      stage: "RESPONSE_PARSING",
      code,
    });
  }

  if (
    url.protocol !== "https:" ||
    !isAllowedHostname(url.hostname, domains) ||
    url.username ||
    url.password
  ) {
    throw new MercadoLivreAffiliateApiError(`${description} is not allowed.`, {
      stage: "RESPONSE_PARSING",
      code,
    });
  }

  url.hash = "";
  return url.toString();
}

export function normalizeMercadoLivreAffiliateProductUrl(value: string) {
  return normalizeAllowedUrl(
    value,
    PRODUCT_DOMAINS,
    "INVALID_PRODUCT_URL",
    "Mercado Livre product URL",
  );
}

export function normalizeMercadoLivreGeneratedAffiliateUrl(value: string) {
  return normalizeAllowedUrl(
    value,
    AFFILIATE_DOMAINS,
    "INVALID_AFFILIATE_URL",
    "Mercado Livre generated affiliate URL",
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function findAffiliateErrorCode(
  value: unknown,
  depth = 0,
): string | number | undefined {
  if (depth > 3) {
    return undefined;
  }

  const record = asRecord(value);

  if (!record) {
    return undefined;
  }

  const directCode = record.code ?? record.error_code;

  if (typeof directCode === "string" || typeof directCode === "number") {
    return directCode;
  }

  for (const nestedValue of [
    record.cause,
    record.causes,
    record.error,
    record.errors,
    record.data,
  ]) {
    const entries = Array.isArray(nestedValue) ? nestedValue : [nestedValue];

    for (const entry of entries) {
      const nestedCode = findAffiliateErrorCode(entry, depth + 1);

      if (nestedCode !== undefined) {
        return nestedCode;
      }
    }
  }

  return undefined;
}

async function responseBody(response: Response) {
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

function responseError(
  response: Response,
  requestUrl: string,
  body: unknown,
  attempts: number,
) {
  const loginRedirect = isMercadoLivreAffiliateLoginRedirect(
    response,
    requestUrl,
  );
  const code =
    findAffiliateErrorCode(body) ??
    (loginRedirect ? "LOGIN_REDIRECT" : `HTTP_${response.status}`);
  const productIneligible = String(code) === "111";
  const sessionExpired =
    loginRedirect || response.status === 401 || response.status === 403;
  const retryable = response.status === 429 || response.status >= 500;

  if (productIneligible) {
    return new MercadoLivreAffiliateApiError(
      "Mercado Livre product is not eligible for the affiliate program.",
      {
        stage: "LINK_GENERATION",
        status: response.status,
        code,
        attempts,
        productIneligible: true,
        retryable: false,
        sessionExpired: false,
      },
    );
  }

  return new MercadoLivreAffiliateApiError(
    sessionExpired
      ? "Mercado Livre affiliate session is expired."
      : `Mercado Livre affiliate link request failed with HTTP ${response.status}.`,
    {
      stage: "LINK_GENERATION",
      status: response.status,
      code,
      attempts,
      retryable,
      sessionExpired,
    },
  );
}

function normalizedAffiliateTag(value: string) {
  const tag = value.trim();

  if (!tag) {
    throw new MercadoLivreAffiliateApiError(
      "Mercado Livre affiliate tag is required.",
      {
        stage: "LINK_GENERATION",
        code: "AFFILIATE_TAG_REQUIRED",
      },
    );
  }

  return tag;
}

export class MercadoLivreAffiliateLinkService {
  private readonly runtime: MercadoLivreAffiliateHttpRuntime;
  private readonly sessionService: MercadoLivreAffiliateSessionService;

  constructor(options: MercadoLivreAffiliateHttpOptions = {}) {
    this.runtime = new MercadoLivreAffiliateHttpRuntime(options);
    this.sessionService = new MercadoLivreAffiliateSessionService(options);
  }

  async create(
    input: CreateMercadoLivreAffiliateLinkInput,
    options: { skipInitialWarmup?: boolean } = {},
  ): Promise<CreateMercadoLivreAffiliateLinkResult> {
    const productUrl = normalizeMercadoLivreAffiliateProductUrl(
      input.productUrl,
    );
    const affiliateTag = normalizedAffiliateTag(input.affiliateTag);
    const originalCookie = normalizeMercadoLivreCookie(input.cookie);
    const originalCsrfToken =
      input.csrfToken ?? extractMercadoLivreCsrfToken(originalCookie) ?? null;
    let cookie = originalCookie;
    let csrfToken = originalCsrfToken;

    if (!options.skipInitialWarmup) {
      const warmed = await this.sessionService.warmup({
        cookie,
        csrfToken,
      });
      cookie = warmed.cookie;
      csrfToken = warmed.csrfToken;
    }

    const url = `${this.runtime.baseUrl}/links`;
    let refreshedAfterForbidden = false;

    for (let attempt = 1; attempt <= this.runtime.maxAttempts; attempt += 1) {
      let response: Response;

      try {
        response = await this.runtime.fetchOnce(url, {
          method: "POST",
          headers: this.runtime.requestHeaders(cookie, csrfToken, true),
          body: JSON.stringify({
            url: productUrl,
            tag: affiliateTag,
          }),
        });
      } catch {
        if (attempt < this.runtime.maxAttempts) {
          await this.runtime.waitBeforeRetry(attempt);
          continue;
        }

        throw new MercadoLivreAffiliateApiError(
          "Mercado Livre affiliate link request failed due to a network error or timeout.",
          {
            stage: "LINK_GENERATION",
            code: "NETWORK_OR_TIMEOUT",
            attempts: attempt,
            retryable: true,
            sessionExpired: false,
          },
        );
      }

      const setCookieHeaders = getMercadoLivreSetCookieHeaders(
        response.headers,
      );

      if (setCookieHeaders.length > 0) {
        cookie = mergeMercadoLivreCookies(cookie, setCookieHeaders);
        csrfToken = extractMercadoLivreCsrfToken(cookie) ?? csrfToken;
      }

      const transient = response.status === 429 || response.status >= 500;

      if (transient && attempt < this.runtime.maxAttempts) {
        await this.runtime.waitBeforeRetry(attempt);
        continue;
      }

      if (
        response.status === 403 &&
        !refreshedAfterForbidden &&
        attempt < this.runtime.maxAttempts
      ) {
        refreshedAfterForbidden = true;
        const warmed = await this.sessionService.warmup({
          cookie,
          csrfToken,
        });
        cookie = warmed.cookie;
        csrfToken = warmed.csrfToken;
        continue;
      }

      const body = await responseBody(response);
      const responseCode = findAffiliateErrorCode(body);

      if (String(responseCode ?? "") === "111") {
        throw responseError(response, url, body, attempt);
      }

      if (!response.ok) {
        throw responseError(response, url, body, attempt);
      }

      const shortUrl = asRecord(body)?.short_url;

      if (typeof shortUrl !== "string" || !shortUrl.trim()) {
        throw new MercadoLivreAffiliateApiError(
          "Mercado Livre affiliate link response did not contain short_url.",
          {
            stage: "RESPONSE_PARSING",
            code: "MISSING_SHORT_URL",
            attempts: attempt,
          },
        );
      }

      const affiliateUrl = normalizeMercadoLivreGeneratedAffiliateUrl(shortUrl);

      return {
        affiliateUrl,
        ...(cookie !== originalCookie ? { refreshedCookie: cookie } : {}),
        ...(csrfToken !== originalCsrfToken
          ? { refreshedCsrfToken: csrfToken }
          : {}),
      };
    }

    throw new MercadoLivreAffiliateApiError(
      "Mercado Livre affiliate link request failed.",
      {
        stage: "LINK_GENERATION",
        code: "REQUEST_FAILED",
      },
    );
  }

  async createAffiliateLink(input: CreateMercadoLivreAffiliateLinkInput) {
    return this.create(input);
  }

  warmupSession(input: { cookie: string; csrfToken?: string | null }) {
    return this.sessionService.warmup(input);
  }
}
