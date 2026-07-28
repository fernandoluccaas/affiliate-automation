import { MercadoLivreAffiliateApiError } from "./affiliate-errors";

const COOKIE_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const COMBINED_SET_COOKIE_BOUNDARY = /^\s*[!#$%&'*+\-.^_`|~0-9A-Za-z]+\s*=/;
const CSRF_COOKIE_NAMES = [
  "_csrf",
  "csrf-token",
  "csrf_token",
  "xsrf-token",
] as const;

function invalidCookieError() {
  return new MercadoLivreAffiliateApiError(
    "Invalid Mercado Livre cookie format.",
    {
      stage: "RESPONSE_PARSING",
      code: "INVALID_COOKIE_FORMAT",
    },
  );
}

function assertCookieName(name: string) {
  if (!COOKIE_NAME_PATTERN.test(name)) {
    throw invalidCookieError();
  }
}

function hasUnsafeControlCharacter(value: string) {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function assertCookieValue(value: string) {
  if (hasUnsafeControlCharacter(value)) {
    throw invalidCookieError();
  }
}

function serializeCookies(cookies: ReadonlyMap<string, string>) {
  return [...cookies.entries()]
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

export function parseMercadoLivreCookie(rawCookie: string) {
  const cookies = new Map<string, string>();

  for (const rawSegment of rawCookie.split(";")) {
    const segment = rawSegment.trim();

    if (!segment) {
      continue;
    }

    const separatorIndex = segment.indexOf("=");

    if (separatorIndex < 1) {
      throw invalidCookieError();
    }

    const name = segment.slice(0, separatorIndex).trim();
    const value = segment.slice(separatorIndex + 1).trim();
    assertCookieName(name);
    assertCookieValue(value);
    cookies.set(name, value);
  }

  return cookies;
}

export function normalizeMercadoLivreCookie(rawCookie: string) {
  return serializeCookies(parseMercadoLivreCookie(rawCookie));
}

function splitCombinedSetCookieHeader(value: string) {
  const headers: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (character === "\\" && quoted) {
      escaped = true;
      continue;
    }

    if (character === '"') {
      quoted = !quoted;
      continue;
    }

    if (
      character === "," &&
      !quoted &&
      COMBINED_SET_COOKIE_BOUNDARY.test(value.slice(index + 1))
    ) {
      const header = value.slice(start, index).trim();

      if (header) {
        headers.push(header);
      }

      start = index + 1;
    }
  }

  const lastHeader = value.slice(start).trim();

  if (lastHeader) {
    headers.push(lastHeader);
  }

  return headers;
}

function individualSetCookieHeaders(headers: readonly string[]) {
  return headers.flatMap((header) =>
    header
      .split(/\r?\n/)
      .flatMap((line) =>
        splitCombinedSetCookieHeader(
          line.replace(/^\s*set-cookie\s*:\s*/i, ""),
        ),
      ),
  );
}

type ParsedSetCookie = {
  name: string;
  value: string;
  expired: boolean;
};

function parseSetCookieHeader(header: string): ParsedSetCookie | null {
  const segments = header.split(";").map((segment) => segment.trim());
  const cookiePair = segments.shift();

  if (!cookiePair) {
    return null;
  }

  const separatorIndex = cookiePair.indexOf("=");

  if (separatorIndex < 1) {
    return null;
  }

  const name = cookiePair.slice(0, separatorIndex).trim();

  if (!COOKIE_NAME_PATTERN.test(name)) {
    return null;
  }

  const value = cookiePair.slice(separatorIndex + 1).trim();

  if (hasUnsafeControlCharacter(value)) {
    return null;
  }

  const attributes = new Map<string, string>();

  for (const segment of segments) {
    if (!segment) {
      continue;
    }

    const attributeSeparator = segment.indexOf("=");
    const attributeName = (
      attributeSeparator === -1 ? segment : segment.slice(0, attributeSeparator)
    )
      .trim()
      .toLowerCase();
    const attributeValue =
      attributeSeparator === -1
        ? ""
        : segment.slice(attributeSeparator + 1).trim();

    if (attributeName) {
      attributes.set(attributeName, attributeValue);
    }
  }

  const rawMaxAge = attributes.get("max-age");
  const maxAge =
    rawMaxAge !== undefined && /^-?\d+$/.test(rawMaxAge)
      ? Number(rawMaxAge)
      : null;
  const expires = attributes.get("expires");
  const expiresAt = expires ? Date.parse(expires) : Number.NaN;
  const expiredByMaxAge = maxAge !== null && maxAge <= 0;
  const expiredByExpires =
    !(maxAge !== null && maxAge > 0) &&
    Number.isFinite(expiresAt) &&
    expiresAt <= Date.now();

  return {
    name,
    value,
    expired: expiredByMaxAge || expiredByExpires,
  };
}

export function mergeMercadoLivreCookies(
  currentCookie: string,
  setCookieHeaders: string[],
) {
  const cookies = parseMercadoLivreCookie(currentCookie);

  for (const header of individualSetCookieHeaders(setCookieHeaders)) {
    const parsed = parseSetCookieHeader(header);

    if (!parsed) {
      continue;
    }

    if (parsed.expired) {
      cookies.delete(parsed.name);
    } else {
      cookies.set(parsed.name, parsed.value);
    }
  }

  return serializeCookies(cookies);
}

function decodeCookieValue(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function extractMercadoLivreCsrfToken(cookie: string) {
  const cookies = [...parseMercadoLivreCookie(cookie).entries()];

  for (const csrfName of CSRF_COOKIE_NAMES) {
    const match = cookies.find(([name]) => name.toLowerCase() === csrfName);
    const value = match?.[1];

    if (value) {
      return decodeCookieValue(value);
    }
  }

  return null;
}
