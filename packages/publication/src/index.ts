import type { Marketplace } from "@affiliate/shared";

export type MessageOffer = {
  title: string;
  originalPrice?: number | string | null;
  currentPrice: number | string;
  discountPercentage?: number | string | null;
  couponCode?: string | null;
  couponExpiration?: Date | string | null;
  freeShipping?: boolean | null;
  shippingStatus?: "FREE" | "NOT_FREE" | "UNKNOWN" | string | null;
  marketplace: Marketplace | string;
  trackingUrl: string;
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

export type PolicyResult = { ok: true } | { ok: false; code: PolicyFailureCode; reason: string };

export function formatBRLCurrency(value: number | string) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(Number(value));
}

export function escapeMessageText(value: string) {
  return value.replace(/\r/g, "").trim();
}

export function deterministicMessageComposer(offer: MessageOffer) {
  const lines = [`\u{1F525} ${escapeMessageText(offer.title)}`, ""];

  if (offer.originalPrice !== null && offer.originalPrice !== undefined) {
    lines.push(`De ${formatBRLCurrency(offer.originalPrice)}`);
  }

  lines.push(`Por ${formatBRLCurrency(offer.currentPrice)}`);

  if (offer.discountPercentage !== null && offer.discountPercentage !== undefined) {
    lines.push(
      `\u{1F4B0} ${Number(offer.discountPercentage).toLocaleString("pt-BR", {
        maximumFractionDigits: 2,
      })}% de desconto`,
    );
  }

  if (offer.couponCode) {
    const couponLine = offer.couponExpiration
      ? `Cupom ${escapeMessageText(offer.couponCode)} valido ate ${new Intl.DateTimeFormat("pt-BR", {
          dateStyle: "short",
          timeStyle: "short",
        }).format(new Date(offer.couponExpiration))}`
      : `Cupom ${escapeMessageText(offer.couponCode)}`;
    lines.push("", couponLine);
  }

  if (offer.shippingStatus === "FREE" || offer.freeShipping === true) {
    lines.push("Frete gratis");
  }

  lines.push("", "\u{1F6D2} Confira:", offer.trackingUrl, "", "#publi - link de afiliado");

  return lines.join("\n");
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
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
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
    if (!offer.category || !channel.allowedCategories.includes(offer.category)) {
      return {
        ok: false,
        code: "CHANNEL_CATEGORY_MISMATCH",
        reason: "Categoria nao permitida para o canal.",
      };
    }
  }

  const minimumScore = Number(channel.minimumScore ?? 0);

  if (Number.isFinite(minimumScore) && minimumScore > 0 && (offer.score ?? 0) < minimumScore) {
    return { ok: false, code: "CHANNEL_MIN_SCORE", reason: "Score abaixo do minimo do canal." };
  }

  const minimumDiscount = Number(channel.minimumDiscountPercentage ?? 0);

  if (Number.isFinite(minimumDiscount) && minimumDiscount > 0) {
    if (offer.discountPercentage === null || offer.discountPercentage === undefined) {
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

export function canScheduleInWindow(input: PublicationWindowInput): PolicyResult {
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
      (input.now.getTime() - input.lastProductPublicationAt.getTime()) / (24 * 60 * 60 * 1000);

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
