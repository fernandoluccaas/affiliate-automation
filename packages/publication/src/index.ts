import type { Marketplace } from "@affiliate/shared";

export type MessageOffer = {
  title: string;
  originalPrice: number | string;
  currentPrice: number | string;
  discountPercentage: number | string;
  couponCode?: string | null;
  couponExpiration?: Date | string | null;
  freeShipping: boolean;
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
  minimumScore: number;
  minimumDiscountPercentage?: number | string | null;
  productRepeatIntervalDays: number;
  allowedMarketplaces: string[];
  allowedCategories: string[];
};

export type OfferPolicyInput = {
  marketplace: string;
  category?: string | null;
  score?: number | null;
  discountPercentage: number | string;
};

export type PublicationWindowInput = {
  channel: ChannelPolicy;
  now: Date;
  publicationsToday: number;
  lastPublicationAt?: Date | null;
  lastProductPublicationAt?: Date | null;
};

export type PolicyResult = { ok: true } | { ok: false; reason: string };

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
  const lines = [
    `🔥 ${escapeMessageText(offer.title)}`,
    "",
    `De ${formatBRLCurrency(offer.originalPrice)}`,
    `Por ${formatBRLCurrency(offer.currentPrice)}`,
    `💰 ${Number(offer.discountPercentage).toLocaleString("pt-BR", {
      maximumFractionDigits: 2,
    })}% de desconto`,
  ];

  if (offer.couponCode) {
    const couponLine = offer.couponExpiration
      ? `Cupom ${escapeMessageText(offer.couponCode)} valido ate ${new Intl.DateTimeFormat("pt-BR", {
          dateStyle: "short",
          timeStyle: "short",
        }).format(new Date(offer.couponExpiration))}`
      : `Cupom ${escapeMessageText(offer.couponCode)}`;
    lines.push("", couponLine);
  }

  if (offer.freeShipping) {
    lines.push("Frete gratis");
  }

  lines.push("", "🛒 Confira:", offer.trackingUrl, "", "#publi - link de afiliado");

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
    return { ok: false, reason: "Canal desativado." };
  }

  if (!["TELEGRAM", "MANUAL_EXPORT"].includes(channel.type)) {
    return { ok: false, reason: "Tipo de canal indisponivel nesta fase." };
  }

  if (
    channel.allowedMarketplaces.length > 0 &&
    !channel.allowedMarketplaces.includes(offer.marketplace)
  ) {
    return { ok: false, reason: "Marketplace nao permitido para o canal." };
  }

  if (
    offer.category &&
    channel.allowedCategories.length > 0 &&
    !channel.allowedCategories.includes(offer.category)
  ) {
    return { ok: false, reason: "Categoria nao permitida para o canal." };
  }

  if ((offer.score ?? 0) < channel.minimumScore) {
    return { ok: false, reason: "Score abaixo do minimo do canal." };
  }

  if (
    channel.minimumDiscountPercentage !== null &&
    channel.minimumDiscountPercentage !== undefined &&
    Number(offer.discountPercentage) < Number(channel.minimumDiscountPercentage)
  ) {
    return { ok: false, reason: "Desconto abaixo do minimo do canal." };
  }

  return { ok: true };
}

export function canScheduleInWindow(input: PublicationWindowInput): PolicyResult {
  if (input.publicationsToday >= input.channel.dailyPublicationLimit) {
    return { ok: false, reason: "Limite diario do canal atingido." };
  }

  if (input.lastPublicationAt) {
    const elapsedMinutes =
      (input.now.getTime() - input.lastPublicationAt.getTime()) / (60 * 1000);

    if (elapsedMinutes < input.channel.minimumIntervalMinutes) {
      return { ok: false, reason: "Intervalo minimo entre publicacoes nao foi atingido." };
    }
  }

  if (!isWithinAllowedWindow(input.channel, input.now)) {
    return { ok: false, reason: "Fora da janela de horario do canal." };
  }

  if (input.lastProductPublicationAt) {
    const elapsedDays =
      (input.now.getTime() - input.lastProductPublicationAt.getTime()) / (24 * 60 * 60 * 1000);

    if (elapsedDays < input.channel.productRepeatIntervalDays) {
      return { ok: false, reason: "Produto publicado recentemente neste canal." };
    }
  }

  return { ok: true };
}
