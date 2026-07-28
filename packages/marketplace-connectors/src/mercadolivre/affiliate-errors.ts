const DEFAULT_ERROR_MESSAGE = "Mercado Livre affiliate request failed.";
const MAX_ERROR_MESSAGE_LENGTH = 500;
const COOKIE_LIKE_VALUE =
  /^(?:[!#$%&'*+\-.^_`|~0-9A-Za-z]+=[^;\r\n]*)(?:;\s*[!#$%&'*+\-.^_`|~0-9A-Za-z]+=[^;\r\n]*)*$/;

export type MercadoLivreAffiliateApiErrorStage =
  "SESSION_WARMUP" | "TAGS" | "LINK_GENERATION" | "RESPONSE_PARSING";

export type MercadoLivreAffiliateApiErrorOptions = {
  stage: MercadoLivreAffiliateApiErrorStage;
  status?: number;
  code?: string | number;
  retryable?: boolean;
  sessionExpired?: boolean;
  productIneligible?: boolean;
  secrets?: readonly string[];
};

function textFromUnknown(value: unknown) {
  if (value instanceof Error) {
    return value.message;
  }

  return typeof value === "string" ? value : DEFAULT_ERROR_MESSAGE;
}

function redactKnownSecrets(value: string, secrets: readonly string[]) {
  let sanitized = value;

  for (const secret of secrets) {
    if (secret) {
      sanitized = sanitized.split(secret).join("[REDACTED]");
    }
  }

  return sanitized;
}

function stripUnsafeControlCharacters(value: string) {
  return [...value]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return (
        code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)
      );
    })
    .join("");
}

export function sanitizeMercadoLivreAffiliateErrorMessage(
  value: unknown,
  secrets: readonly string[] = [],
) {
  const raw = textFromUnknown(value);
  const redactedRaw = COOKIE_LIKE_VALUE.test(raw.trim()) ? "[REDACTED]" : raw;
  const sanitized = stripUnsafeControlCharacters(
    redactKnownSecrets(redactedRaw, secrets)
      .replace(
        /\b(?:authorization|proxy-authorization|cookie|set-cookie|x-csrf-token|x-xsrf-token)\b\s*[:=]\s*[^\r\n]*/gi,
        "[REDACTED]",
      )
      .replace(
        /(["']?(?:cookie|set-cookie|csrf|csrf-token|csrf_token|xsrf-token|access[_-]?token|refresh[_-]?token)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^,}\s]+)/gi,
        "$1[REDACTED]",
      )
      .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
      .replace(
        /([?&](?:cookie|csrf|xsrf|access_token|refresh_token|token)=)[^&#\s]+/gi,
        "$1[REDACTED]",
      )
      .replace(
        /\b(?:[!#$%&'*+\-.^_`|~0-9A-Za-z]+=[^;\s,]+;\s*)+[!#$%&'*+\-.^_`|~0-9A-Za-z]+=[^;\s,]+/g,
        "[REDACTED]",
      ),
  )
    .trim()
    .slice(0, MAX_ERROR_MESSAGE_LENGTH);

  return sanitized || DEFAULT_ERROR_MESSAGE;
}

export function sanitizeMercadoLivreAffiliateError(
  value: unknown,
  secrets: readonly string[] = [],
) {
  return sanitizeMercadoLivreAffiliateErrorMessage(value, secrets);
}

function sanitizeCode(
  code: string | number | undefined,
  secrets: readonly string[],
) {
  if (typeof code === "number") {
    return code;
  }

  if (typeof code !== "string") {
    return undefined;
  }

  const sanitized = sanitizeMercadoLivreAffiliateErrorMessage(code, secrets);
  return sanitized.slice(0, 100);
}

function isRetryableStatus(status: number | undefined) {
  return (
    status === 429 || (status !== undefined && status >= 500 && status < 600)
  );
}

export class MercadoLivreAffiliateApiError extends Error {
  readonly status: number | undefined;
  readonly code: string | number | undefined;
  readonly stage: MercadoLivreAffiliateApiErrorStage;
  readonly retryable: boolean;
  readonly sessionExpired: boolean;
  readonly productIneligible: boolean;

  constructor(message: string, options: MercadoLivreAffiliateApiErrorOptions) {
    const sanitizedMessage = sanitizeMercadoLivreAffiliateErrorMessage(
      message,
      options.secrets,
    );
    super(sanitizedMessage);
    this.name = "MercadoLivreAffiliateApiError";
    this.status = options.status;
    this.code = sanitizeCode(options.code, options.secrets ?? []);
    this.stage = options.stage;
    this.retryable = options.retryable ?? isRetryableStatus(options.status);
    this.sessionExpired =
      options.sessionExpired ??
      (options.status === 401 || options.status === 403);
    this.productIneligible =
      options.productIneligible ?? String(options.code ?? "") === "111";
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      stage: this.stage,
      retryable: this.retryable,
      sessionExpired: this.sessionExpired,
      productIneligible: this.productIneligible,
      ...(this.status !== undefined ? { status: this.status } : {}),
      ...(this.code !== undefined ? { code: this.code } : {}),
    };
  }
}

export function isMercadoLivreAffiliateApiError(
  value: unknown,
): value is MercadoLivreAffiliateApiError {
  return value instanceof MercadoLivreAffiliateApiError;
}
