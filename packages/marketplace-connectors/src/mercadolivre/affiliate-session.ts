import {
  extractMercadoLivreCsrfToken,
  mergeMercadoLivreCookies,
  normalizeMercadoLivreCookie,
} from "./affiliate-cookie";
import {
  MercadoLivreAffiliateApiError,
  isMercadoLivreAffiliateApiError,
  type MercadoLivreAffiliateApiErrorStage,
} from "./affiliate-errors";
import {
  parseMercadoLivreAffiliateTags,
  selectMercadoLivreAffiliateTag,
  type MercadoLivreAffiliateTag,
} from "./affiliate-types";

const DEFAULT_AFFILIATE_BASE_URL =
  "https://www.mercadolivre.com.br/affiliate-program/api/v2/stripe/user";
const DEFAULT_AFFILIATE_REFERER =
  "https://www.mercadolivre.com.br/afiliados/linkbuilder";
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_BASE_MS = 250;
const MAX_ATTEMPTS = 3;

export type MercadoLivreAffiliateFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type MercadoLivreAffiliateHttpOptions = {
  fetchFn?: MercadoLivreAffiliateFetch;
  baseUrl?: string;
  referer?: string;
  userAgent?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  backoffBaseMs?: number;
  sleep?: (durationMs: number) => Promise<void>;
  random?: () => number;
  env?: NodeJS.ProcessEnv;
};

export type WarmMercadoLivreAffiliateSessionInput = {
  cookie: string;
  csrfToken?: string | null;
};

export type WarmMercadoLivreAffiliateSessionResult = {
  cookie: string;
  csrfToken: string | null;
};

export type ValidateMercadoLivreAffiliateSessionInput =
  WarmMercadoLivreAffiliateSessionInput & {
    preferredTag?: string | null;
  };

export type ValidateMercadoLivreAffiliateSessionResult =
  WarmMercadoLivreAffiliateSessionResult & {
    tags: MercadoLivreAffiliateTag[];
    selectedTag: MercadoLivreAffiliateTag | null;
  };

type HeadersWithGetSetCookie = Headers & {
  getSetCookie?: () => string[];
};

function positiveInteger(value: unknown, fallback: number) {
  const parsed =
    typeof value === "number" ? value : Number(String(value ?? ""));
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeNumber(value: unknown, fallback: number) {
  const parsed =
    typeof value === "number" ? value : Number(String(value ?? ""));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalizeBaseUrl(value: string) {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new MercadoLivreAffiliateApiError(
      "Mercado Livre affiliate base URL is invalid.",
      {
        stage: "RESPONSE_PARSING",
        code: "INVALID_AFFILIATE_BASE_URL",
      },
    );
  }

  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "www.mercadolivre.com.br" ||
    !url.pathname.startsWith("/affiliate-program/api/")
  ) {
    throw new MercadoLivreAffiliateApiError(
      "Mercado Livre affiliate base URL is not allowed.",
      {
        stage: "RESPONSE_PARSING",
        code: "AFFILIATE_BASE_URL_NOT_ALLOWED",
      },
    );
  }

  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

function normalizeReferer(value: string) {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new MercadoLivreAffiliateApiError(
      "Mercado Livre Link Builder URL is invalid.",
      {
        stage: "RESPONSE_PARSING",
        code: "INVALID_LINK_BUILDER_URL",
      },
    );
  }

  const pathname = url.pathname.replace(/\/+$/, "");

  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "www.mercadolivre.com.br" ||
    pathname !== "/afiliados/linkbuilder"
  ) {
    throw new MercadoLivreAffiliateApiError(
      "Mercado Livre Link Builder URL is not allowed.",
      {
        stage: "RESPONSE_PARSING",
        code: "LINK_BUILDER_URL_NOT_ALLOWED",
      },
    );
  }

  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function splitCombinedSetCookieHeader(value: string) {
  return value
    .split(/,(?=\s*[!#$%&'*+\-.^_`|~0-9A-Za-z]+\s*=)/)
    .map((header) => header.trim())
    .filter(Boolean);
}

export function getMercadoLivreSetCookieHeaders(headers: Headers) {
  const getSetCookie = (headers as HeadersWithGetSetCookie).getSetCookie;

  if (typeof getSetCookie === "function") {
    const values = getSetCookie.call(headers);

    if (values.length > 0) {
      return values;
    }
  }

  const combined = headers.get("set-cookie");
  return combined ? splitCombinedSetCookieHeader(combined) : [];
}

function isTransientStatus(status: number) {
  return status === 429 || status >= 500;
}

function isLoginUrl(value: string | null, requestUrl: string) {
  if (!value) {
    return false;
  }

  let url: URL;

  try {
    url = new URL(value, requestUrl);
  } catch {
    return false;
  }

  const hostname = url.hostname.toLowerCase();
  const pathname = url.pathname.toLowerCase();
  return (
    hostname === "auth.mercadolivre.com.br" ||
    hostname === "auth.mercadolibre.com" ||
    pathname.includes("/login") ||
    pathname.includes("/lgz/") ||
    pathname.includes("/authorization")
  );
}

export function isMercadoLivreAffiliateLoginRedirect(
  response: Response,
  requestUrl: string,
) {
  if (
    response.status >= 300 &&
    response.status < 400 &&
    isLoginUrl(response.headers.get("location"), requestUrl)
  ) {
    return true;
  }

  return response.redirected && isLoginUrl(response.url, requestUrl);
}

function responseError(
  response: Response,
  stage: MercadoLivreAffiliateApiErrorStage,
  requestUrl: string,
  attempts = 1,
) {
  const loginRedirect = isMercadoLivreAffiliateLoginRedirect(
    response,
    requestUrl,
  );
  const authenticationFailure =
    loginRedirect || response.status === 401 || response.status === 403;

  return new MercadoLivreAffiliateApiError(
    authenticationFailure
      ? "Mercado Livre affiliate session is expired."
      : `Mercado Livre affiliate request failed with HTTP ${response.status}.`,
    {
      stage,
      status: response.status,
      code: loginRedirect ? "LOGIN_REDIRECT" : `HTTP_${response.status}`,
      attempts,
      retryable: isTransientStatus(response.status),
      sessionExpired: authenticationFailure,
    },
  );
}

export class MercadoLivreAffiliateHttpRuntime {
  readonly baseUrl: string;
  readonly referer: string;
  readonly origin: string;
  readonly userAgent: string;
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly backoffBaseMs: number;

  private readonly fetchFn: MercadoLivreAffiliateFetch;
  private readonly sleepFn: (durationMs: number) => Promise<void>;
  private readonly randomFn: () => number;

  constructor(options: MercadoLivreAffiliateHttpOptions = {}) {
    const env = options.env ?? process.env;
    this.baseUrl = normalizeBaseUrl(
      options.baseUrl?.trim() ||
        env.MERCADOLIVRE_AFFILIATE_BASE_URL?.trim() ||
        DEFAULT_AFFILIATE_BASE_URL,
    );
    this.referer = normalizeReferer(
      options.referer?.trim() ||
        env.MERCADOLIVRE_AFFILIATE_REFERER?.trim() ||
        DEFAULT_AFFILIATE_REFERER,
    );
    this.origin = new URL(this.referer).origin;
    this.userAgent =
      options.userAgent?.trim() ||
      env.MERCADOLIVRE_AFFILIATE_USER_AGENT?.trim() ||
      DEFAULT_USER_AGENT;
    this.timeoutMs = positiveInteger(
      options.timeoutMs ?? env.MERCADOLIVRE_AFFILIATE_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
    );
    this.maxAttempts = Math.min(
      MAX_ATTEMPTS,
      positiveInteger(
        options.maxAttempts ?? env.MERCADOLIVRE_AFFILIATE_MAX_RETRIES,
        DEFAULT_MAX_ATTEMPTS,
      ),
    );
    this.backoffBaseMs = nonNegativeNumber(
      options.backoffBaseMs,
      DEFAULT_BACKOFF_BASE_MS,
    );
    this.fetchFn = options.fetchFn ?? fetch;
    this.sleepFn =
      options.sleep ??
      ((durationMs) =>
        new Promise((resolve) => setTimeout(resolve, durationMs)));
    this.randomFn = options.random ?? Math.random;
  }

  async fetchOnce(url: string, init: RequestInit) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      return await this.fetchFn(url, {
        ...init,
        redirect: "manual",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async waitBeforeRetry(failedAttempt: number) {
    const exponential =
      this.backoffBaseMs * 2 ** Math.max(0, failedAttempt - 1);
    const jitter = this.backoffBaseMs * this.randomFn();
    await this.sleepFn(exponential + jitter);
  }

  requestHeaders(
    cookie: string,
    csrfToken?: string | null,
    includeContentType = false,
  ) {
    const headers = new Headers({
      Accept: "application/json, text/plain, */*",
      Cookie: cookie,
      Origin: this.origin,
      Referer: this.referer,
      "User-Agent": this.userAgent,
    });

    if (includeContentType) {
      headers.set("Content-Type", "application/json");
    }

    if (csrfToken) {
      headers.set("X-CSRF-Token", csrfToken);
    }

    return headers;
  }
}

export async function requestMercadoLivreAffiliateWithRetry(
  runtime: MercadoLivreAffiliateHttpRuntime,
  url: string,
  init: RequestInit,
  stage: MercadoLivreAffiliateApiErrorStage,
) {
  for (let attempt = 1; attempt <= runtime.maxAttempts; attempt += 1) {
    let response: Response;

    try {
      response = await runtime.fetchOnce(url, init);
    } catch {
      if (attempt < runtime.maxAttempts) {
        await runtime.waitBeforeRetry(attempt);
        continue;
      }

      throw new MercadoLivreAffiliateApiError(
        "Mercado Livre affiliate request failed due to a network error or timeout.",
        {
          stage,
          code: "NETWORK_OR_TIMEOUT",
          attempts: attempt,
          retryable: true,
          sessionExpired: false,
        },
      );
    }

    if (isTransientStatus(response.status) && attempt < runtime.maxAttempts) {
      await runtime.waitBeforeRetry(attempt);
      continue;
    }

    return { response, attempts: attempt };
  }

  throw new MercadoLivreAffiliateApiError(
    "Mercado Livre affiliate request failed.",
    {
      stage,
      code: "REQUEST_FAILED",
    },
  );
}

function updatedSessionValues(
  currentCookie: string,
  currentCsrfToken: string | null,
  response: Response,
) {
  const setCookieHeaders = getMercadoLivreSetCookieHeaders(response.headers);
  const cookie =
    setCookieHeaders.length > 0
      ? mergeMercadoLivreCookies(currentCookie, setCookieHeaders)
      : currentCookie;
  const csrfToken = extractMercadoLivreCsrfToken(cookie) ?? currentCsrfToken;
  return { cookie, csrfToken };
}

export class MercadoLivreAffiliateSessionService {
  private readonly runtime: MercadoLivreAffiliateHttpRuntime;

  constructor(options: MercadoLivreAffiliateHttpOptions = {}) {
    this.runtime = new MercadoLivreAffiliateHttpRuntime(options);
  }

  async warmup(
    input: WarmMercadoLivreAffiliateSessionInput,
  ): Promise<WarmMercadoLivreAffiliateSessionResult> {
    const cookie = normalizeMercadoLivreCookie(input.cookie);
    const csrfToken =
      extractMercadoLivreCsrfToken(cookie) ?? input.csrfToken ?? null;
    const { response, attempts } = await requestMercadoLivreAffiliateWithRetry(
      this.runtime,
      this.runtime.referer,
      {
        method: "GET",
        headers: this.runtime.requestHeaders(cookie, csrfToken),
      },
      "SESSION_WARMUP",
    );
    const updated = updatedSessionValues(cookie, csrfToken, response);

    if (!response.ok) {
      throw responseError(
        response,
        "SESSION_WARMUP",
        this.runtime.referer,
        attempts,
      );
    }

    return updated;
  }

  async validateSession(
    input: ValidateMercadoLivreAffiliateSessionInput,
  ): Promise<ValidateMercadoLivreAffiliateSessionResult> {
    let session = await this.warmup(input);
    let refreshedAfterForbidden = false;

    while (true) {
      try {
        const tagResult = await this.fetchTags(session);
        return {
          cookie: tagResult.cookie,
          csrfToken: tagResult.csrfToken,
          tags: tagResult.tags,
          selectedTag: selectMercadoLivreAffiliateTag(
            tagResult.tags,
            input.preferredTag,
          ),
        };
      } catch (error) {
        if (
          !refreshedAfterForbidden &&
          isMercadoLivreAffiliateApiError(error) &&
          error.status === 403
        ) {
          refreshedAfterForbidden = true;
          session = await this.warmup(session);
          continue;
        }

        throw error;
      }
    }
  }

  async getTags(
    input: ValidateMercadoLivreAffiliateSessionInput,
  ): Promise<ValidateMercadoLivreAffiliateSessionResult> {
    return this.validateSession(input);
  }

  private async fetchTags(session: WarmMercadoLivreAffiliateSessionResult) {
    const url = `${this.runtime.baseUrl}/tags`;
    const { response, attempts } = await requestMercadoLivreAffiliateWithRetry(
      this.runtime,
      url,
      {
        method: "GET",
        headers: this.runtime.requestHeaders(session.cookie, session.csrfToken),
      },
      "TAGS",
    );

    if (!response.ok) {
      throw responseError(response, "TAGS", url, attempts);
    }

    const updated = updatedSessionValues(
      session.cookie,
      session.csrfToken,
      response,
    );
    let body: unknown;

    try {
      body = await response.json();
    } catch {
      throw new MercadoLivreAffiliateApiError(
        "Mercado Livre affiliate tags response is invalid.",
        {
          stage: "RESPONSE_PARSING",
          code: "INVALID_TAGS_RESPONSE",
        },
      );
    }

    return {
      ...updated,
      tags: parseMercadoLivreAffiliateTags(body),
    };
  }
}
