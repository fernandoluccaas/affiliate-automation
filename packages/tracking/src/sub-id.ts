import { createHmac, timingSafeEqual } from "node:crypto";

function subIdToken(secret: string, name: string, value: string) {
  return createHmac("sha256", secret)
    .update(`${name}:${value}`)
    .digest("base64url")
    .slice(0, 10);
}

export function createAttributionSubId(input: {
  secret: string;
  marketplace: "MERCADO_LIVRE" | "SHOPEE";
  channelId: string;
  publicationId: string;
}) {
  if (input.secret.length < 32) {
    throw new Error("ATTRIBUTION_SUB_ID_SECRET_INVALID");
  }
  const market = input.marketplace === "MERCADO_LIVRE" ? "ml" : "sh";
  const channel = subIdToken(input.secret, "channel", input.channelId);
  const publication = subIdToken(input.secret, "publication", input.publicationId);
  const body = `aa1_${market}_${channel}_${publication}`;
  const checksum = createHmac("sha256", input.secret)
    .update(body)
    .digest("base64url")
    .slice(0, 8);
  return `${body}_${checksum}`;
}

export function parseAttributionSubId(value: string, secret: string) {
  if (secret.length < 32) {
    return { ok: false, code: "SUB_ID_SECRET_INVALID" } as const;
  }
  const match = /^aa1_(ml|sh)_([A-Za-z0-9_-]{10})_([A-Za-z0-9_-]{10})_([A-Za-z0-9_-]{8})$/.exec(value);
  if (!match) return { ok: false, code: "SUB_ID_FORMAT_INVALID" } as const;
  const body = value.slice(0, value.lastIndexOf("_"));
  const expected = createHmac("sha256", secret)
    .update(body)
    .digest("base64url")
    .slice(0, 8);
  const provided = match[4]!;
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(provided))) {
    return { ok: false, code: "SUB_ID_CHECKSUM_INVALID" } as const;
  }
  return {
    ok: true,
    version: "aa1",
    marketplace: match[1] === "ml" ? "MERCADO_LIVRE" : "SHOPEE",
    channelHash: match[2]!,
    publicationHash: match[3]!,
  } as const;
}
