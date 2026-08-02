export type PreparedRemoteImage = {
  bytes: Uint8Array;
  contentType: string;
  filename: string;
};

export type PrepareRemoteImageOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
};

function isPrivateIpv4(host: string) {
  const octets = host.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value))) {
    return false;
  }
  const [a, b] = octets;
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 100 && b !== undefined && b >= 64 && b <= 127) ||
    (a === 172 && b !== undefined && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isPrivateHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    host === "localhost" ||
    host === "::1" ||
    host === "::" ||
    host.endsWith(".localhost") ||
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    /^fe[89ab]/.test(host) ||
    isPrivateIpv4(host)
  );
}

export function validateRemoteImageUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("MEDIA_URL_INVALID");
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    isPrivateHost(host)
  ) {
    throw new Error("MEDIA_URL_NOT_ALLOWED");
  }
  return url;
}

export async function prepareRemoteImage(
  value: string,
  options: PrepareRemoteImageOptions = {},
): Promise<PreparedRemoteImage> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  const maxRedirects = options.maxRedirects ?? 3;
  let url = validateRemoteImageUrl(value);

  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        redirect: "manual",
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location || redirect === maxRedirects) {
          throw new Error("MEDIA_REDIRECT_LIMIT");
        }
        url = validateRemoteImageUrl(new URL(location, url).toString());
        continue;
      }
      if (!response.ok) throw new Error(`MEDIA_HTTP_${response.status}`);
      const contentType = response.headers.get("content-type")?.split(";")[0];
      if (!contentType?.startsWith("image/")) {
        throw new Error("MEDIA_CONTENT_TYPE_INVALID");
      }
      const contentLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        throw new Error("MEDIA_TOO_LARGE");
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > maxBytes) throw new Error("MEDIA_TOO_LARGE");
      const extension = contentType.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "img";
      return { bytes, contentType, filename: `offer.${extension}` };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("MEDIA_REDIRECT_LIMIT");
}
