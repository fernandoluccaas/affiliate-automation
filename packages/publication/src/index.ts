import type { Marketplace } from "@affiliate/shared";

export type MessageOffer = {
  title: string;
  originalPrice?: number | string | null;
  currentPrice: number | string;
  discountPercentage?: number | string | null;
  couponCode?: string | null;
  couponUrl?: string | null;
  couponDescription?: string | null;
  couponExpiration?: Date | string | null;
  freeShipping?: boolean | null;
  shippingStatus?: "FREE" | "NOT_FREE" | "UNKNOWN" | string | null;
  marketplace: Marketplace | string;
  trackingUrl: string;
  footer?: string | null;
};

export type PromoMessageOptions = {
  headlineStyle: "MARKETPLACE";
  emojiLevel: "STANDARD";
  showOriginalPrice: boolean;
  showCoupon: boolean;
  showFreeShipping: boolean;
};

export type PromoMessageInput = MessageOffer & {
  seed?: string;
  recentHeadlines?: readonly string[];
  headlineSuggestion?: string | null;
  options?: Partial<PromoMessageOptions>;
};

export type PromoMessageResult = {
  headline: string;
  message: string;
};

export const MERCADO_LIVRE_HEADLINES = [
  "MELI CHEGOUUUUU 💛",
  "SURREAAAAL AGORA 🥵",
  "PROMOO MERCADO LIVRE 😮‍💨🤌",
  "MELI ENDOIDOOOU 😱🔥",
  "NESSE PREÇO É LOUCURAAAA 🤯🤯",
  "MUITO BARATO 😱😱",
  "OLHA ESSE PREÇOOOO 😳🔥",
  "MELI TÁ IMPOSSÍVEL HOJE 😱",
  "CORRE QUE TÁ BARATO DEMAIS 🏃🔥",
  "QUE PREÇO É ESSEEE? 🤯",
] as const;

export const SHOPEE_HEADLINES = [
  "SHÔ PIROU DE VEZ 🥵",
  "PREÇO DESPENCOU NA SHÔ 👀🔥",
  "A SHÔ SURTOU 😱🔥",
  "SHÔ TÁ DANDO DE GRAÇA 🤯",
  "CORRE PRA SHÔ 🏃🔥",
  "OLHA ESSE PREÇO NA SHÔ 😳",
  "MUITO BARATO 😱😱",
  "NESSE PREÇO É LOUCURAAAA 🤯🤯",
  "SURREAAAAL AGORA 🥵",
  "QUE ISSO, SHÔ? 😱",
] as const;

export const GENERIC_HEADLINES = [
  "SURREAAAAL AGORA 🥵",
  "NESSE PREÇO É LOUCURAAAA 🤯🤯",
  "MUITO BARATO 😱😱",
  "CORRE QUE TÁ BARATO DEMAIS 🏃🔥",
  "OLHA ESSE PREÇOOOO 😳",
  "QUE PREÇO É ESSEEE? 🤯",
  "ACHADINHO DO DIA 🔥",
  "BAIXOU MUITOOOO 😱",
  "PREÇO BOM DEMAIS 🤌🔥",
] as const;

export const DEFAULT_PROMO_MESSAGE_OPTIONS: PromoMessageOptions = {
  headlineStyle: "MARKETPLACE",
  emojiLevel: "STANDARD",
  showOriginalPrice: true,
  showCoupon: true,
  showFreeShipping: true,
};

export type ChannelPolicy = {
  enabled: boolean;
  type: string;
  timezone: string;
  dailyPublicationLimit: number;
  minimumIntervalMinutes: number;
  allowedStartTime?: string | null;
  allowedEndTime?: string | null;
  minimumScore?: number | string | null;
  minimumDiscountPercentage?: number | string | null;
  productRepeatIntervalDays: number;
  allowedMarketplaces: string[];
  allowedCategories: string[];
};

export type OfferPolicyInput = {
  marketplace: string;
  category?: string | null;
  score?: number | null;
  discountPercentage?: number | string | null;
  scoreCompletenessPercentage?: number | string | null;
  stockStatus?: string | null;
  shippingStatus?: string | null;
};

export type PublicationWindowInput = {
  channel: ChannelPolicy;
  now: Date;
  publicationsToday: number;
  lastPublicationAt?: Date | null;
  lastProductPublicationAt?: Date | null;
};

export type PolicyFailureCode =
  | "CHANNEL_DISABLED"
  | "CHANNEL_TYPE_UNAVAILABLE"
  | "CHANNEL_MARKETPLACE_MISMATCH"
  | "CHANNEL_CATEGORY_MISMATCH"
  | "CHANNEL_MIN_SCORE"
  | "CHANNEL_MIN_DISCOUNT"
  | "CHANNEL_DAILY_LIMIT"
  | "CHANNEL_MIN_INTERVAL"
  | "CHANNEL_TIME_WINDOW"
  | "CHANNEL_PRODUCT_REPEAT";

export type PolicyResult =
  { ok: true } | { ok: false; code: PolicyFailureCode; reason: string };

export function formatBRLCurrency(value: number | string) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(Number(value));
}

export function escapeMessageText(value: string) {
  return value.replace(/\r/g, "").trim();
}

function normalizeProductTitle(value: string) {
  return escapeMessageText(value).replace(/\s+/g, " ");
}

function stableHash(value: string) {
  let hash = 2_166_136_261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }

  return hash >>> 0;
}

function headlinePool(marketplace: Marketplace | string): string[] {
  const specific: readonly string[] =
    marketplace === "MERCADO_LIVRE"
      ? MERCADO_LIVRE_HEADLINES
      : marketplace === "SHOPEE"
        ? SHOPEE_HEADLINES
        : [];

  return [...new Set([...specific, ...GENERIC_HEADLINES])];
}

export function selectPromotionalHeadline(input: {
  marketplace: Marketplace | string;
  seed: string;
  recentHeadlines?: readonly string[];
  suggestion?: string | null;
}) {
  const pool = headlinePool(input.marketplace);
  const recent = new Set(
    (input.recentHeadlines ?? [])
      .slice(0, 5)
      .map((headline) => escapeMessageText(headline)),
  );
  const suggestion = input.suggestion
    ? escapeMessageText(input.suggestion)
    : null;

  if (suggestion && pool.includes(suggestion) && !recent.has(suggestion)) {
    return suggestion;
  }

  const unused = pool.filter((headline) => !recent.has(headline));
  const candidates =
    unused.length > 0
      ? unused
      : pool.filter(
          (headline) =>
            headline !== escapeMessageText(input.recentHeadlines?.[0] ?? ""),
        );
  const safeCandidates = candidates.length > 0 ? candidates : pool;

  return safeCandidates[
    stableHash(input.seed) % safeCandidates.length
  ] as string;
}

function validOptionalUrl(value: string | null | undefined) {
  if (!value) return null;

  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function validOriginalPrice(
  originalPrice: number | string | null | undefined,
  currentPrice: number | string,
) {
  const original = Number(originalPrice);
  const current = Number(currentPrice);

  return Number.isFinite(original) &&
    original > 0 &&
    Number.isFinite(current) &&
    original > current
    ? original
    : null;
}

export class PromoMessageBuilder {
  build(input: PromoMessageInput): PromoMessageResult {
    const options = {
      ...DEFAULT_PROMO_MESSAGE_OPTIONS,
      ...input.options,
    };
    const headline = selectPromotionalHeadline({
      marketplace: input.marketplace,
      seed:
        input.seed ??
        `${input.marketplace}:${input.title}:${input.trackingUrl}`,
      ...(input.recentHeadlines
        ? { recentHeadlines: input.recentHeadlines }
        : {}),
      ...(input.headlineSuggestion
        ? { suggestion: input.headlineSuggestion }
        : {}),
    });
    const lines = [headline, "", normalizeProductTitle(input.title)];
    const originalPrice = validOriginalPrice(
      input.originalPrice,
      input.currentPrice,
    );

    if (options.showOriginalPrice && originalPrice !== null) {
      lines.push("", `De: ${formatBRLCurrency(originalPrice)}`);
    }

    lines.push("", `Por: ${formatBRLCurrency(input.currentPrice)} ✅`);

    if (
      options.showFreeShipping &&
      (input.shippingStatus === "FREE" || input.freeShipping === true)
    ) {
      lines.push("", "🚚 Frete grátis");
    }

    const couponCode = input.couponCode
      ? normalizeProductTitle(input.couponCode)
      : null;
    const couponUrl = validOptionalUrl(input.couponUrl);

    if (options.showCoupon && (couponCode || couponUrl)) {
      if (couponUrl && couponUrl !== input.trackingUrl) {
        const description = normalizeProductTitle(
          input.couponDescription ?? couponCode ?? "",
        );
        lines.push(
          "",
          `🎟️ Use cupom${description ? ` ${description}` : ""} | resgate aqui:`,
          couponUrl,
        );
      } else if (couponCode) {
        lines.push("", "🎟️ Use o cupom:", couponCode);
      }
    }

    lines.push("", "🛒 Compre aqui:", input.trackingUrl);

    const footer = input.footer ? escapeMessageText(input.footer) : "";
    if (footer) {
      lines.push("", footer);
    }

    return {
      headline,
      message: lines.join("\n"),
    };
  }
}

export function buildPromoMessage(input: PromoMessageInput) {
  return new PromoMessageBuilder().build(input);
}

export function deterministicMessageComposer(offer: MessageOffer) {
  return buildPromoMessage(offer).message;
}

function parseMinutes(time?: string | null) {
  if (!time) {
    return null;
  }

  const [hours, minutes] = time.split(":").map(Number);

  if (
    hours === undefined ||
    minutes === undefined ||
    !Number.isInteger(hours) ||
    !Number.isInteger(minutes)
  ) {
    return null;
  }

  return hours * 60 + minutes;
}

function zonedMinutes(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const minute = Number(
    parts.find((part) => part.type === "minute")?.value ?? 0,
  );
  return hour * 60 + minute;
}

function zonedDateParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  return {
    year: Number(parts.find((part) => part.type === "year")?.value),
    month: Number(parts.find((part) => part.type === "month")?.value),
    day: Number(parts.find((part) => part.type === "day")?.value),
  };
}

function timezoneOffsetMs(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  const hour = value("hour") === 24 ? 0 : value("hour");
  const representedAsUtc = Date.UTC(
    value("year"),
    value("month") - 1,
    value("day"),
    hour,
    value("minute"),
    value("second"),
  );

  return representedAsUtc - date.getTime();
}

function localMidnightToUtc(
  input: { year: number; month: number; day: number },
  timezone: string,
) {
  const localAsUtc = Date.UTC(input.year, input.month - 1, input.day);
  let result = new Date(
    localAsUtc - timezoneOffsetMs(new Date(localAsUtc), timezone),
  );
  result = new Date(localAsUtc - timezoneOffsetMs(result, timezone));
  return result;
}

export function getZonedDayRange(now: Date, timezone: string) {
  const current = zonedDateParts(now, timezone);
  const nextDate = new Date(
    Date.UTC(current.year, current.month - 1, current.day + 1),
  );
  const next = {
    year: nextDate.getUTCFullYear(),
    month: nextDate.getUTCMonth() + 1,
    day: nextDate.getUTCDate(),
  };

  return {
    start: localMidnightToUtc(current, timezone),
    end: localMidnightToUtc(next, timezone),
  };
}

export function isWithinAllowedWindow(channel: ChannelPolicy, now: Date) {
  const start = parseMinutes(channel.allowedStartTime);
  const end = parseMinutes(channel.allowedEndTime);

  if (start === null || end === null) {
    return true;
  }

  const current = zonedMinutes(now, channel.timezone);

  if (start <= end) {
    return current >= start && current <= end;
  }

  return current >= start || current <= end;
}

export function isOfferCompatibleWithChannel(
  offer: OfferPolicyInput,
  channel: ChannelPolicy,
): PolicyResult {
  if (!channel.enabled) {
    return { ok: false, code: "CHANNEL_DISABLED", reason: "Canal desativado." };
  }

  if (!["TELEGRAM", "MANUAL_EXPORT"].includes(channel.type)) {
    return {
      ok: false,
      code: "CHANNEL_TYPE_UNAVAILABLE",
      reason: "Tipo de canal indisponivel nesta fase.",
    };
  }

  if (
    channel.allowedMarketplaces.length > 0 &&
    !channel.allowedMarketplaces.includes(offer.marketplace)
  ) {
    return {
      ok: false,
      code: "CHANNEL_MARKETPLACE_MISMATCH",
      reason: "Marketplace nao permitido para o canal.",
    };
  }

  if (channel.allowedCategories.length > 0) {
    if (
      !offer.category ||
      !channel.allowedCategories.includes(offer.category)
    ) {
      return {
        ok: false,
        code: "CHANNEL_CATEGORY_MISMATCH",
        reason: "Categoria nao permitida para o canal.",
      };
    }
  }

  const minimumScore = Number(channel.minimumScore ?? 0);

  if (
    Number.isFinite(minimumScore) &&
    minimumScore > 0 &&
    (offer.score ?? 0) < minimumScore
  ) {
    return {
      ok: false,
      code: "CHANNEL_MIN_SCORE",
      reason: "Score abaixo do minimo do canal.",
    };
  }

  const minimumDiscount = Number(channel.minimumDiscountPercentage ?? 0);

  if (Number.isFinite(minimumDiscount) && minimumDiscount > 0) {
    if (
      offer.discountPercentage === null ||
      offer.discountPercentage === undefined
    ) {
      return {
        ok: false,
        code: "CHANNEL_MIN_DISCOUNT",
        reason: "Desconto indisponivel para a politica do canal.",
      };
    }

    if (Number(offer.discountPercentage) < minimumDiscount) {
      return {
        ok: false,
        code: "CHANNEL_MIN_DISCOUNT",
        reason: "Desconto abaixo do minimo do canal.",
      };
    }
  }

  return { ok: true };
}

export function canScheduleInWindow(
  input: PublicationWindowInput,
): PolicyResult {
  if (input.publicationsToday >= input.channel.dailyPublicationLimit) {
    return {
      ok: false,
      code: "CHANNEL_DAILY_LIMIT",
      reason: "Limite diario do canal atingido.",
    };
  }

  if (input.lastPublicationAt) {
    const elapsedMinutes =
      (input.now.getTime() - input.lastPublicationAt.getTime()) / (60 * 1000);

    if (elapsedMinutes < input.channel.minimumIntervalMinutes) {
      return {
        ok: false,
        code: "CHANNEL_MIN_INTERVAL",
        reason: "Intervalo minimo entre publicacoes nao foi atingido.",
      };
    }
  }

  if (!isWithinAllowedWindow(input.channel, input.now)) {
    return {
      ok: false,
      code: "CHANNEL_TIME_WINDOW",
      reason: "Fora da janela de horario do canal.",
    };
  }

  if (input.lastProductPublicationAt) {
    const elapsedDays =
      (input.now.getTime() - input.lastProductPublicationAt.getTime()) /
      (24 * 60 * 60 * 1000);

    if (elapsedDays < input.channel.productRepeatIntervalDays) {
      return {
        ok: false,
        code: "CHANNEL_PRODUCT_REPEAT",
        reason: "Produto publicado recentemente neste canal.",
      };
    }
  }

  return { ok: true };
}
