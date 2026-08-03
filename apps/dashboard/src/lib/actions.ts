"use server";

import {
  archiveWhatsAppWebPublication,
  Prisma,
  authorizeWhatsAppWebRetry,
  authorizeWhatsAppWebSend,
  cancelWhatsAppWebPublication,
  prisma,
  resolveWhatsAppWebDelivery,
  revokeWhatsAppWebSendAuthorization,
} from "@affiliate/database";
import {
  MessageGenerationService,
  OllamaAiProvider,
  OpenAiProvider,
} from "@affiliate/ai-copywriter";
import {
  MercadoLivreApiError,
  createMercadoLivreConnector,
  getMercadoLivreConfig,
  type MarketplaceConnector,
  type MercadoLivreCategory,
  type MercadoLivreCategorySearchProbeAttempt,
  type MercadoLivreHighlightCandidate,
} from "@affiliate/marketplace-connectors";
import {
  MercadoLivreHighlightResolver,
  applyAffiliateLinksBatch,
  collectMercadoLivreCandidates,
  diagnoseMercadoLivreProduct,
  parseAffiliateLinksCsv,
  parsePipeAffiliateLinks,
  previewAffiliateLinksBatch,
  queueAffiliateLinksBatch,
  type AffiliateLinkBatchEntry,
  type MercadoLivreProductResolutionDiagnostics,
} from "@affiliate/marketplace-discovery";
import {
  formatOfferFormError,
  ingestOffer,
  offerFormSchema,
  type OfferFormInput,
} from "@affiliate/ingestion";
import { validateMarketplaceAffiliateUrl } from "@affiliate/validation";
import bcrypt from "bcryptjs";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import {
  sanitizeWhatsAppWebProfileKey,
  TelegramPublisher,
} from "@affiliate/publisher-connectors";
import { createSession, destroySession, requireSession } from "./session";
import {
  WORKER_CONTROLS_KEY,
  workerControlsFromValue,
} from "./worker-operations";
import {
  assistedCancellationData,
  assistedConfirmationData,
  assistedFailureData,
  convertLegacyWhatsAppConfiguration,
  groupDisplayNameFromSnapshot,
} from "./assisted-publications";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export type LoginState = {
  error?: string;
};

export async function loginAction(
  _state: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return { error: "Informe email e senha validos." };
  }

  const user = await prisma.user.findUnique({
    where: { email: parsed.data.email },
    select: { id: true, email: true, role: true, passwordHash: true },
  });

  if (!user) {
    return { error: "Credenciais invalidas." };
  }

  const passwordMatches = await bcrypt.compare(
    parsed.data.password,
    user.passwordHash,
  );

  if (!passwordMatches) {
    return { error: "Credenciais invalidas." };
  }

  await createSession({ id: user.id, email: user.email, role: user.role });
  redirect("/");
}

export async function logoutAction() {
  await destroySession();
  redirect("/login");
}

export type CreateOfferState = {
  ok: boolean;
  message: string;
  offerId?: string | undefined;
};

export async function createManualOfferAction(
  input: OfferFormInput,
): Promise<CreateOfferState> {
  const parsed = offerFormSchema.safeParse(input);

  if (!parsed.success) {
    return {
      ok: false,
      message:
        formatOfferFormError(parsed.error) || "Dados da oferta invalidos.",
    };
  }

  const result = await ingestOffer(parsed.data);

  return {
    ok: result.ok,
    offerId: result.offerId,
    message: result.ok
      ? `Oferta cadastrada com score ${result.score} e status READY_TO_PUBLISH.`
      : `Oferta processada com status ${result.status}: ${result.statusReason}`,
  };
}

const channelSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1, "Informe o nome do canal."),
  type: z.enum([
    "TELEGRAM",
    "MANUAL_EXPORT",
    "WHATSAPP_GROUPS",
    "WHATSAPP_CHANNEL",
    "WHATSAPP_CLOUD_API",
    "WHATSAPP_GROUPS_API",
  ]),
  enabled: z.boolean(),
  timezone: z.string().trim().min(1),
  dailyPublicationLimit: z.coerce.number().int().min(1),
  minimumIntervalMinutes: z.coerce.number().int().min(0),
  allowedStartTime: z.string().optional(),
  allowedEndTime: z.string().optional(),
  minimumScore: z.coerce.number().int().min(0).max(100),
  minimumDiscountPercentage: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.coerce.number().min(0).max(100).optional(),
  ),
  productRepeatIntervalDays: z.coerce.number().int().min(0),
  allowedMarketplaces: z.string().optional(),
  allowedCategories: z.string().optional(),
  telegramChatId: z.string().optional(),
  publicationMode: z.enum(["ASSISTED", "WEB_EXPERIMENTAL"]).optional(),
  groupDisplayName: z.string().trim().optional(),
  customHeader: z.string().trim().max(500).optional(),
  customFooter: z.string().trim().max(500).optional(),
  sendImage: z.boolean().optional(),
  maxPendingPublications: z.coerce.number().int().min(1).max(50).optional(),
  webProfileKey: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
});

const mercadoLivreConfigSchema = z.object({
  enabled: z.boolean(),
  siteId: z.string().trim().min(1, "Informe o site ID."),
  categoryIds: z.string().optional(),
  bestSellersEnabled: z.boolean(),
  minimumPrice: z.preprocess(
    (value) => (value === "" || value === null ? undefined : value),
    z.coerce.number().positive().optional(),
  ),
  maximumPrice: z.preprocess(
    (value) => (value === "" || value === null ? undefined : value),
    z.coerce.number().positive().optional(),
  ),
  minimumDiscountPercentage: z.preprocess(
    (value) => (value === "" || value === null ? undefined : value),
    z.coerce.number().min(0).max(100).optional(),
  ),
  minimumScore: z.coerce.number().int().min(0).max(100),
  maxCandidatesPerCategory: z.coerce.number().int().min(1).max(20),
  refreshIntervalMinutes: z.coerce.number().int().min(15),
});

const affiliateLinkSchema = z.object({
  offerId: z.string().min(1),
  affiliateUrl: z.string().trim().url("Informe uma URL afiliada valida."),
  affiliateLabel: z.string().trim().optional(),
});

const mercadoLivreCategorySchema = z.object({
  categoryId: z.string().trim().min(1, "Informe a categoria."),
});

const mercadoLivreProductSchema = z.object({
  productId: z
    .string()
    .trim()
    .regex(/^MLB\d+$/i),
});

function stringList(value?: string) {
  return value
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

function channelPayload(formData: FormData) {
  const parsed = channelSchema.safeParse({
    id: formData.get("id")?.toString(),
    name: formData.get("name")?.toString(),
    type: formData.get("type")?.toString(),
    enabled: formData.get("enabled") === "on",
    timezone: formData.get("timezone")?.toString() || "America/Fortaleza",
    dailyPublicationLimit: formData.get("dailyPublicationLimit"),
    minimumIntervalMinutes: formData.get("minimumIntervalMinutes"),
    allowedStartTime: formData.get("allowedStartTime")?.toString(),
    allowedEndTime: formData.get("allowedEndTime")?.toString(),
    minimumScore: formData.get("minimumScore"),
    minimumDiscountPercentage: formData.get("minimumDiscountPercentage"),
    productRepeatIntervalDays: formData.get("productRepeatIntervalDays"),
    allowedMarketplaces: formData.get("allowedMarketplaces")?.toString(),
    allowedCategories: formData.get("allowedCategories")?.toString(),
    telegramChatId: formData.get("telegramChatId")?.toString(),
    publicationMode: formData.get("publicationMode")?.toString() || "ASSISTED",
    groupDisplayName: formData.get("groupDisplayName")?.toString(),
    customHeader: formData.get("customHeader")?.toString(),
    customFooter: formData.get("customFooter")?.toString(),
    sendImage: formData.get("sendImage") === "on",
    maxPendingPublications: formData.get("maxPendingPublications") || 3,
    webProfileKey: formData.get("webProfileKey")?.toString() || "principal",
  });

  if (!parsed.success) {
    throw new Error(
      parsed.error.issues[0]?.message ?? "Dados do canal invalidos.",
    );
  }

  const channel = parsed.data;
  const configuration =
    channel.type === "TELEGRAM"
      ? channel.telegramChatId
        ? { chatId: channel.telegramChatId.trim() }
        : Prisma.JsonNull
      : channel.type === "WHATSAPP_GROUPS"
        ? {
            publicationMode: channel.publicationMode ?? "ASSISTED",
            whatsappDestinationType: "GROUP",
            groupDisplayName: channel.groupDisplayName || channel.name,
            webProfileKey: sanitizeWhatsAppWebProfileKey(
              channel.webProfileKey ?? "principal",
            ),
            ...(!channel.id
              ? {
                  webAutomationEnabled: false,
                  webAutomationOwnershipConfirmed: false,
                  webAutomationPaused: false,
                }
              : {}),
            customHeader: channel.customHeader || null,
            customFooter: channel.customFooter || null,
            sendImage: channel.sendImage ?? true,
            maxPendingPublications: channel.maxPendingPublications ?? 3,
          }
        : Prisma.JsonNull;

  return {
    channel,
    data: {
      name: channel.name,
      type: channel.type,
      enabled: channel.enabled,
      timezone: channel.timezone,
      dailyLimit: channel.dailyPublicationLimit,
      dailyPublicationLimit: channel.dailyPublicationLimit,
      minIntervalMinutes: channel.minimumIntervalMinutes,
      minimumIntervalMinutes: channel.minimumIntervalMinutes,
      allowedStartTime: channel.allowedStartTime || null,
      allowedEndTime: channel.allowedEndTime || null,
      allowedHours: [],
      minScore: channel.minimumScore,
      minimumScore: channel.minimumScore,
      minDiscountPercentage: channel.minimumDiscountPercentage ?? null,
      minRepeatDays: channel.productRepeatIntervalDays,
      productRepeatIntervalDays: channel.productRepeatIntervalDays,
      allowedMarketplaces: stringList(channel.allowedMarketplaces),
      allowedCategories: stringList(channel.allowedCategories),
      configuration,
    },
  };
}

export async function createChannelAction(formData: FormData) {
  const { channel, data } = channelPayload(formData);
  if (channel.type === "WHATSAPP_CHANNEL") {
    throw new Error("WHATSAPP_CHANNEL e legado e nao aceita novos registros.");
  }
  await prisma.channel.create({ data });
  revalidatePath("/canais");
  redirect("/canais?message=created");
}

export async function updateChannelAction(formData: FormData) {
  const { channel, data } = channelPayload(formData);

  if (!channel.id) {
    throw new Error("Canal nao informado.");
  }

  const current = await prisma.channel.findUnique({
    where: { id: channel.id },
    select: { configuration: true },
  });
  const currentConfiguration =
    current?.configuration &&
    typeof current.configuration === "object" &&
    !Array.isArray(current.configuration)
      ? (current.configuration as Record<string, unknown>)
      : {};
  const submittedConfiguration =
    data.configuration &&
    typeof data.configuration === "object" &&
    !Array.isArray(data.configuration)
      ? (data.configuration as Record<string, unknown>)
      : {};
  const configurationChanged = [
    "publicationMode",
    "groupDisplayName",
    "webProfileKey",
    "sendImage",
  ].some((key) => currentConfiguration[key] !== submittedConfiguration[key]);
  await prisma.channel.update({
    where: { id: channel.id },
    data: {
      ...data,
      ...(channel.type === "WHATSAPP_GROUPS"
        ? {
            configuration: {
              ...currentConfiguration,
              ...submittedConfiguration,
              ...(configurationChanged
                ? {
                    lastSuccessfulDryRunAt: null,
                    lastSuccessfulDryRunConfigurationFingerprint: null,
                    webLastDryRunStatus: "INVALIDATED",
                  }
                : {}),
            },
          }
        : {}),
    },
  });
  revalidatePath("/canais");
  redirect("/canais?message=updated");
}

async function whatsappWebChannel(formData: FormData) {
  const id = formData.get("id")?.toString();
  if (!id) throw new Error("Canal nao informado.");
  const channel = await prisma.channel.findFirst({
    where: { id, type: "WHATSAPP_GROUPS" },
  });
  if (!channel) throw new Error("Grupo do WhatsApp nao encontrado.");
  const configuration =
    channel.configuration &&
    typeof channel.configuration === "object" &&
    !Array.isArray(channel.configuration)
      ? (channel.configuration as Record<string, unknown>)
      : {};
  return { channel, configuration };
}

async function updateWhatsAppWebConfiguration(
  id: string,
  configuration: Record<string, unknown>,
  patch: Record<string, unknown>,
) {
  await prisma.channel.update({
    where: { id },
    data: {
      configuration: {
        ...configuration,
        ...patch,
      } as Prisma.InputJsonValue,
    },
  });
  revalidatePath("/canais");
}

export async function confirmWhatsAppWebOwnershipAction(formData: FormData) {
  const user = await requireSession();
  const { channel, configuration } = await whatsappWebChannel(formData);
  if (formData.get("ownershipConfirmed") !== "on") {
    throw new Error("Confirme a autorizacao para este grupo.");
  }
  await updateWhatsAppWebConfiguration(channel.id, configuration, {
    webAutomationOwnershipConfirmed: true,
    webAutomationConfirmedAt: new Date().toISOString(),
    webAutomationConfirmedBy: user.id,
  });
  redirect("/canais?message=web-ownership-confirmed");
}

export async function setWhatsAppWebEnabledAction(formData: FormData) {
  await requireSession();
  const { channel, configuration } = await whatsappWebChannel(formData);
  const enabled = formData.get("enabled") === "true";
  if (enabled && configuration.webAutomationOwnershipConfirmed !== true) {
    throw new Error("WHATSAPP_WEB_OWNERSHIP_NOT_CONFIRMED");
  }
  await updateWhatsAppWebConfiguration(channel.id, configuration, {
    webAutomationEnabled: enabled,
    publicationMode: enabled ? "WEB_EXPERIMENTAL" : "ASSISTED",
  });
  redirect(`/canais?message=${enabled ? "web-enabled" : "web-disabled"}`);
}

export async function setWhatsAppWebPausedAction(formData: FormData) {
  await requireSession();
  const { channel, configuration } = await whatsappWebChannel(formData);
  const paused = formData.get("paused") === "true";
  await updateWhatsAppWebConfiguration(channel.id, configuration, {
    webAutomationPaused: paused,
    webAutomationPauseReason: paused ? "MANUAL_PAUSE" : null,
  });
  redirect(`/canais?message=${paused ? "web-paused" : "web-resumed"}`);
}

export async function invalidateWhatsAppWebAuthorizationAction(
  formData: FormData,
) {
  await requireSession();
  const { channel, configuration } = await whatsappWebChannel(formData);
  await updateWhatsAppWebConfiguration(channel.id, configuration, {
    webAutomationEnabled: false,
    webAutomationOwnershipConfirmed: false,
    webAutomationConfirmedAt: null,
    webAutomationConfirmedBy: null,
    publicationMode: "ASSISTED",
    lastSuccessfulDryRunAt: null,
    lastSuccessfulDryRunConfigurationFingerprint: null,
  });
  redirect("/canais?message=web-invalidated");
}

export async function reviewWhatsAppWebDeliveryAction(formData: FormData) {
  const user = await requireSession();
  const publicationId = formData.get("publicationId")?.toString();
  const decision = formData.get("decision")?.toString();
  const confirmed = formData.get("confirmed") === "true";
  const reason = formData.get("reason")?.toString().trim() || null;
  if (
    !publicationId ||
    !confirmed ||
    !["DELIVERED", "NOT_DELIVERED", "KEEP_UNCERTAIN"].includes(decision || "")
  ) {
    throw new Error("Revisao invalida.");
  }
  await resolveWhatsAppWebDelivery(prisma, {
    publicationId,
    decision: decision as "DELIVERED" | "NOT_DELIVERED" | "KEEP_UNCERTAIN",
    actorId: user.id,
    reason,
    autoPauseAfterFirstSuccess: true,
  });
  revalidatePath("/publicacoes");
}

export async function authorizeWhatsAppWebRetryAction(formData: FormData) {
  const user = await requireSession();
  const publicationId = formData.get("publicationId")?.toString();
  const confirmed =
    formData.get("confirmation") === "AUTHORIZE_ONE_WHATSAPP_WEB_RETRY";
  if (!publicationId || !confirmed) throw new Error("Revisao invalida.");
  await authorizeWhatsAppWebRetry(prisma, {
    publicationId,
    actorId: user.id,
  });
  revalidatePath("/publicacoes");
}

export async function authorizeWhatsAppWebSendAction(formData: FormData) {
  const user = await requireSession();
  const publicationId = formData.get("publicationId")?.toString();
  const confirmed =
    formData.get("confirmation") === "AUTHORIZE_ONE_WHATSAPP_WEB_SEND";
  const expiresInMinutes = Number(formData.get("expiresInMinutes") ?? 15);
  if (!publicationId || !confirmed) throw new Error("Confirmacao invalida.");
  await authorizeWhatsAppWebSend(prisma, {
    publicationId,
    actorId: user.id,
    expiresInMinutes,
  });
  revalidatePath("/publicacoes");
}

export async function revokeWhatsAppWebSendAuthorizationAction(
  formData: FormData,
) {
  const user = await requireSession();
  const publicationId = formData.get("publicationId")?.toString();
  const reason = formData.get("reason")?.toString().trim();
  const confirmed = formData.get("confirmed") === "true";
  if (!publicationId || !reason || !confirmed) {
    throw new Error("Revogacao invalida.");
  }
  await revokeWhatsAppWebSendAuthorization(prisma, {
    publicationId,
    actorId: user.id,
    reason,
  });
  revalidatePath("/publicacoes");
}

export async function cancelWhatsAppWebPublicationAction(formData: FormData) {
  const user = await requireSession();
  const publicationId = formData.get("publicationId")?.toString();
  const reason = formData.get("reason")?.toString().trim();
  const confirmed = formData.get("confirmed") === "true";
  if (!publicationId || !reason || !confirmed) {
    throw new Error("Cancelamento invalido.");
  }
  await cancelWhatsAppWebPublication(prisma, {
    publicationId,
    actorId: user.id,
    reason,
  });
  revalidatePath("/publicacoes");
}

export async function archiveWhatsAppWebPublicationAction(formData: FormData) {
  const user = await requireSession();
  const publicationId = formData.get("publicationId")?.toString();
  const reason = formData.get("reason")?.toString().trim();
  const confirmed = formData.get("confirmed") === "true";
  if (!publicationId || !reason || !confirmed) {
    throw new Error("Arquivamento invalido.");
  }
  await archiveWhatsAppWebPublication(prisma, {
    publicationId,
    actorId: user.id,
    reason,
  });
  revalidatePath("/publicacoes");
}

export async function toggleChannelAction(formData: FormData) {
  const id = formData.get("id")?.toString();
  const enabled = formData.get("enabled") === "true";

  if (!id) {
    throw new Error("Canal nao informado.");
  }

  await prisma.channel.update({ where: { id }, data: { enabled } });
  revalidatePath("/canais");
  redirect(`/canais?message=${enabled ? "enabled" : "disabled"}`);
}

export async function testTelegramChannelAction(formData: FormData) {
  const id = formData.get("id")?.toString();

  if (!id) {
    throw new Error("Canal nao informado.");
  }

  const channel = await prisma.channel.findUnique({ where: { id } });

  if (!channel || channel.type !== "TELEGRAM") {
    redirect("/canais?message=telegram-unavailable");
  }

  const configuration =
    channel.configuration &&
    typeof channel.configuration === "object" &&
    !Array.isArray(channel.configuration)
      ? (channel.configuration as Record<string, unknown>)
      : {};
  const publisher = new TelegramPublisher({
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId:
      typeof configuration.chatId === "string"
        ? configuration.chatId
        : process.env.TELEGRAM_CHAT_ID,
  });
  const ok = await publisher.validateCredentials();

  redirect(`/canais?message=${ok ? "telegram-ok" : "telegram-failed"}`);
}

export async function convertLegacyWhatsAppChannelAction(formData: FormData) {
  await requireSession();
  const id = formData.get("id")?.toString();
  if (!id) throw new Error("Canal legado nao informado.");

  const legacy = await prisma.channel.findFirst({
    where: { id, type: "WHATSAPP_CHANNEL" },
    select: { id: true, name: true, configuration: true },
  });
  if (!legacy)
    throw new Error("Registro WHATSAPP_CHANNEL legado nao encontrado.");

  await prisma.channel.update({
    where: { id: legacy.id },
    data: {
      type: "WHATSAPP_GROUPS",
      configuration: convertLegacyWhatsAppConfiguration(
        legacy.configuration,
        legacy.name,
      ),
    },
  });
  revalidatePath("/canais");
  revalidatePath("/publicacoes-assistidas");
  redirect("/canais?message=legacy-converted");
}

async function assistedPublication(formData: FormData) {
  const id = formData.get("publicationId")?.toString();
  if (!id) throw new Error("Publicacao nao informada.");
  const publication = await prisma.publication.findFirst({
    where: {
      id,
      status: "AWAITING_MANUAL_PUBLICATION",
      channel: { type: "WHATSAPP_GROUPS" },
    },
    select: {
      id: true,
      offerId: true,
      metadata: true,
      channel: { select: { name: true, configuration: true } },
    },
  });
  if (!publication) throw new Error("Pendencia assistida nao encontrada.");
  return publication;
}

export async function confirmAssistedPublicationAction(formData: FormData) {
  const user = await requireSession();
  const publication = await assistedPublication(formData);
  const now = new Date();
  const groupDisplayName = groupDisplayNameFromSnapshot(
    publication.metadata,
    publication.channel.configuration,
    publication.channel.name,
  );
  await prisma.$transaction([
    prisma.publication.update({
      where: { id: publication.id },
      data: assistedConfirmationData(
        publication.metadata,
        user.id,
        now,
        groupDisplayName,
      ),
    }),
    prisma.offer.update({
      where: { id: publication.offerId },
      data: { status: "PUBLISHED", publishedAt: now },
    }),
  ]);
  revalidatePath("/publicacoes-assistidas");
}

export async function cancelAssistedPublicationAction(formData: FormData) {
  const user = await requireSession();
  const publication = await assistedPublication(formData);
  const now = new Date();
  await prisma.publication.update({
    where: { id: publication.id },
    data: assistedCancellationData(publication.metadata, user.id, now),
  });
  revalidatePath("/publicacoes-assistidas");
}

export async function failAssistedPublicationAction(formData: FormData) {
  const user = await requireSession();
  const publication = await assistedPublication(formData);
  const reason = formData.get("reason")?.toString();
  const now = new Date();
  await prisma.publication.update({
    where: { id: publication.id },
    data: assistedFailureData(publication.metadata, user.id, now, reason),
  });
  revalidatePath("/publicacoes-assistidas");
}

function uniqueStringList(values: string[]) {
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))];
}

function categoryPath(category: MercadoLivreCategory) {
  const path =
    category.pathFromRoot.length > 0
      ? category.pathFromRoot
      : [{ id: category.id, name: category.name }];
  return path
    .map((item) => item.name)
    .filter(Boolean)
    .join(" > ");
}

function categoryTestQuery(params: Record<string, string | number | boolean>) {
  const query = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    query.set(key, String(value));
  }

  return query.toString();
}

function highlightTypeCounts(highlights: MercadoLivreHighlightCandidate[]) {
  return highlights.reduce(
    (counts, candidate) => {
      if (candidate.type === "ITEM") {
        counts.item += 1;
      } else if (candidate.type === "PRODUCT") {
        counts.product += 1;
      } else if (candidate.type === "USER_PRODUCT") {
        counts.userProduct += 1;
      } else {
        counts.unknown += 1;
      }

      return counts;
    },
    { item: 0, product: 0, userProduct: 0, unknown: 0 },
  );
}

function emptyProductDiagnostics(): MercadoLivreProductResolutionDiagnostics {
  return {
    productDirectWinnerCount: 0,
    productParentCount: 0,
    productLeafCount: 0,
    productResolvedDirectly: 0,
    productResolvedViaChild: 0,
    productResolvedViaItems: 0,
    productResolvedViaCatalogPdp: 0,
    productCanonicalPdpCandidates: 0,
    productCanonicalPdpResolved: 0,
    productDetailEnrichmentUnavailable: false,
    productPdpFallbackEligible: false,
    productItemsFetched: 0,
    productItemsUsable: 0,
    productItemsSkipped: 0,
    productLeafWithoutWinner: 0,
    productParentWithoutResolvableChild: 0,
  };
}

function addProductDiagnostics(
  target: MercadoLivreProductResolutionDiagnostics,
  source?: MercadoLivreProductResolutionDiagnostics,
) {
  if (!source) {
    return;
  }

  target.productDirectWinnerCount += source.productDirectWinnerCount;
  target.productParentCount += source.productParentCount;
  target.productLeafCount += source.productLeafCount;
  target.productResolvedDirectly += source.productResolvedDirectly;
  target.productResolvedViaChild += source.productResolvedViaChild;
  target.productResolvedViaItems += source.productResolvedViaItems;
  target.productResolvedViaCatalogPdp += source.productResolvedViaCatalogPdp;
  target.productCanonicalPdpCandidates += source.productCanonicalPdpCandidates;
  target.productCanonicalPdpResolved += source.productCanonicalPdpResolved;
  target.productDetailEnrichmentUnavailable ||=
    source.productDetailEnrichmentUnavailable;
  target.productPdpFallbackEligible ||= source.productPdpFallbackEligible;
  target.productItemsFetched += source.productItemsFetched;
  target.productItemsUsable += source.productItemsUsable;
  target.productItemsSkipped += source.productItemsSkipped;
  target.productLeafWithoutWinner += source.productLeafWithoutWinner;
  target.productParentWithoutResolvableChild +=
    source.productParentWithoutResolvableChild;
}

async function validateMercadoLivreDiscoveryCategory(
  connector: MarketplaceConnector,
  categoryId: string,
  options: { requireLeaf: boolean },
) {
  let category: MercadoLivreCategory | null;

  try {
    category = await connector.getCategory(categoryId);
  } catch (error) {
    if (error instanceof MercadoLivreApiError && error.status === 404) {
      return { ok: false as const, message: "category-not-found" };
    }

    return { ok: false as const, message: "category-api-error" };
  }

  if (!category) {
    return { ok: false as const, message: "category-not-found" };
  }

  if (options.requireLeaf && category.children.length > 0) {
    return { ok: false as const, message: "category-not-leaf", category };
  }

  return { ok: true as const, category };
}

async function upsertMercadoLivreConfig(data: {
  enabled: boolean;
  siteId: string;
  categoryIds: string[];
  bestSellersEnabled: boolean;
  minimumPrice?: number | null;
  maximumPrice?: number | null;
  minimumDiscountPercentage?: number | null;
  minimumScore: number;
  maxCandidatesPerCategory: number;
  refreshIntervalMinutes: number;
}) {
  const existing = await prisma.mercadoLivreDiscoveryConfig.findFirst({
    select: { id: true },
  });
  const payload = {
    enabled: data.enabled,
    siteId: data.siteId,
    categoryIds: uniqueStringList(data.categoryIds),
    bestSellersEnabled: data.bestSellersEnabled,
    minimumPrice: data.minimumPrice ?? null,
    maximumPrice: data.maximumPrice ?? null,
    minimumDiscountPercentage: data.minimumDiscountPercentage ?? null,
    minimumScore: data.minimumScore,
    maxCandidatesPerCategory: data.maxCandidatesPerCategory,
    refreshIntervalMinutes: data.refreshIntervalMinutes,
  };

  if (existing) {
    await prisma.mercadoLivreDiscoveryConfig.update({
      where: { id: existing.id },
      data: payload,
    });
  } else {
    await prisma.mercadoLivreDiscoveryConfig.create({ data: payload });
  }
}

function decimalToString(value: Prisma.Decimal | null) {
  return value === null ? undefined : value.toString();
}

type MercadoLivreTestFailureCode =
  | "MELI_NOT_CONNECTED"
  | "MELI_AUTH_ERROR"
  | "MELI_API_UNAVAILABLE"
  | "MELI_CONFIGURATION_ERROR"
  | "MELI_INTERNAL_ERROR";

function mercadoLivreFailureMessage(code: MercadoLivreTestFailureCode) {
  return {
    MELI_NOT_CONNECTED: "meli-not-connected",
    MELI_AUTH_ERROR: "meli-auth-error",
    MELI_API_UNAVAILABLE: "meli-api-unavailable",
    MELI_CONFIGURATION_ERROR: "meli-configuration-error",
    MELI_INTERNAL_ERROR: "meli-internal-error",
  }[code];
}

function classifyMercadoLivreTestError(
  error: unknown,
): MercadoLivreTestFailureCode {
  if (error instanceof MercadoLivreApiError) {
    if ([401, 403].includes(error.status)) {
      return "MELI_AUTH_ERROR";
    }

    return "MELI_API_UNAVAILABLE";
  }

  const message = error instanceof Error ? error.message : "";

  if (/not connected|refresh token|reauth|oauth|token/i.test(message)) {
    return "MELI_AUTH_ERROR";
  }

  if (/config|client|redirect|encryption|secret/i.test(message)) {
    return "MELI_CONFIGURATION_ERROR";
  }

  if (/fetch|timeout|network|unavailable|api/i.test(message)) {
    return "MELI_API_UNAVAILABLE";
  }

  return "MELI_INTERNAL_ERROR";
}

export async function testOpenAiCopyAction() {
  let service: MessageGenerationService;

  try {
    service = new MessageGenerationService({
      provider: new OpenAiProvider(),
    });
  } catch {
    redirect("/integracoes?message=openai-fallback");
  }

  const result = await service.generate({
    title: "[TESTE] Oferta operacional",
    marketplace: "SHOPEE",
    category: "teste",
    originalPrice: "199.90",
    currentPrice: "149.90",
    discountPercentage: "25.01",
    couponCode: "TESTE10",
    couponExpiration: new Date(Date.now() + 24 * 60 * 60 * 1000),
    freeShipping: true,
    shippingStatus: "FREE",
    rating: "4.8",
    salesCount: 120,
    trackingUrl: "https://example.com/go/teste-openai",
  });

  redirect(
    `/integracoes?message=${
      result.source === "AI_GENERATED" && result.aiValidationPassed
        ? "openai-ok"
        : "openai-fallback"
    }`,
  );
}

export async function testOllamaCopyAction() {
  const service = new MessageGenerationService({
    provider: new OllamaAiProvider(),
  });
  const result = await service.generate({
    title: "[TESTE] Oferta operacional local",
    marketplace: "SHOPEE",
    category: "teste",
    originalPrice: "199.90",
    currentPrice: "149.90",
    discountPercentage: "25.01",
    couponCode: "TESTE10",
    couponExpiration: new Date(Date.now() + 24 * 60 * 60 * 1000),
    freeShipping: true,
    shippingStatus: "FREE",
    rating: "4.8",
    salesCount: 120,
    trackingUrl: "https://example.com/go/teste-ollama",
  });

  redirect(
    `/integracoes?message=${
      result.source === "AI_GENERATED" && result.aiProvider === "OLLAMA"
        ? "ollama-ok"
        : "ollama-fallback"
    }`,
  );
}

export async function saveMercadoLivreConfigAction(formData: FormData) {
  const parsed = mercadoLivreConfigSchema.safeParse({
    enabled: formData.get("enabled") === "on",
    siteId: formData.get("siteId")?.toString(),
    categoryIds: formData.get("categoryIds")?.toString(),
    bestSellersEnabled: formData.get("bestSellersEnabled") === "on",
    minimumPrice: formData.get("minimumPrice"),
    maximumPrice: formData.get("maximumPrice"),
    minimumDiscountPercentage: formData.get("minimumDiscountPercentage"),
    minimumScore: formData.get("minimumScore"),
    maxCandidatesPerCategory: formData.get("maxCandidatesPerCategory"),
    refreshIntervalMinutes: formData.get("refreshIntervalMinutes"),
  });

  if (!parsed.success) {
    redirect("/integracoes/mercado-livre?message=config-invalid");
  }

  const data = parsed.data;
  const categoryIds = stringList(data.categoryIds);

  if (categoryIds.length > 0) {
    let connector: MarketplaceConnector;

    try {
      connector = await createMercadoLivreConnector();
    } catch {
      redirect("/integracoes/mercado-livre?message=category-api-error");
    }

    for (const categoryId of categoryIds) {
      const validation = await validateMercadoLivreDiscoveryCategory(
        connector,
        categoryId,
        {
          requireLeaf: data.bestSellersEnabled,
        },
      );

      if (!validation.ok) {
        redirect(
          `/integracoes/mercado-livre?message=${validation.message}&categoryId=${encodeURIComponent(categoryId)}`,
        );
      }
    }
  }

  await upsertMercadoLivreConfig({
    enabled: data.enabled,
    siteId: data.siteId,
    categoryIds,
    bestSellersEnabled: data.bestSellersEnabled,
    minimumPrice: data.minimumPrice ?? null,
    maximumPrice: data.maximumPrice ?? null,
    minimumDiscountPercentage: data.minimumDiscountPercentage ?? null,
    minimumScore: data.minimumScore,
    maxCandidatesPerCategory: data.maxCandidatesPerCategory,
    refreshIntervalMinutes: data.refreshIntervalMinutes,
  });

  revalidatePath("/integracoes");
  revalidatePath("/integracoes/mercado-livre");
  redirect("/integracoes/mercado-livre?message=config-saved");
}

export async function addMercadoLivreCategoryAction(formData: FormData) {
  const parsed = mercadoLivreCategorySchema.safeParse({
    categoryId: formData.get("categoryId")?.toString(),
  });

  if (!parsed.success) {
    redirect("/integracoes/mercado-livre?message=category-invalid");
  }

  const [config, connector] = await Promise.all([
    prisma.mercadoLivreDiscoveryConfig.findFirst({
      orderBy: { updatedAt: "desc" },
    }),
    createMercadoLivreConnector().catch(() => null),
  ]);

  if (!connector) {
    redirect("/integracoes/mercado-livre?message=category-api-error");
  }

  const validation = await validateMercadoLivreDiscoveryCategory(
    connector,
    parsed.data.categoryId,
    {
      requireLeaf: true,
    },
  );

  if (!validation.ok) {
    redirect(
      `/integracoes/mercado-livre?message=${validation.message}&categoryId=${encodeURIComponent(parsed.data.categoryId)}`,
    );
  }

  await upsertMercadoLivreConfig({
    enabled: config?.enabled ?? false,
    siteId: config?.siteId ?? getMercadoLivreConfig().siteId,
    categoryIds: [
      ...stringList(
        Array.isArray(config?.categoryIds) ? config.categoryIds.join(",") : "",
      ),
      validation.category.id,
    ],
    bestSellersEnabled: config?.bestSellersEnabled ?? true,
    minimumPrice: config?.minimumPrice ? Number(config.minimumPrice) : null,
    maximumPrice: config?.maximumPrice ? Number(config.maximumPrice) : null,
    minimumDiscountPercentage:
      config?.minimumDiscountPercentage !== null &&
      config?.minimumDiscountPercentage !== undefined
        ? Number(config.minimumDiscountPercentage)
        : null,
    minimumScore: config?.minimumScore ?? 0,
    maxCandidatesPerCategory: config?.maxCandidatesPerCategory ?? 20,
    refreshIntervalMinutes: config?.refreshIntervalMinutes ?? 360,
  });

  revalidatePath("/integracoes/mercado-livre");
  redirect(
    `/integracoes/mercado-livre?message=category-added&categoryId=${encodeURIComponent(validation.category.id)}`,
  );
}

export async function testMercadoLivreCategoryAction(formData: FormData) {
  const parsed = mercadoLivreCategorySchema.safeParse({
    categoryId: formData.get("categoryId")?.toString(),
  });

  if (!parsed.success) {
    redirect("/integracoes/mercado-livre?message=category-invalid");
  }

  let connector: MarketplaceConnector;

  try {
    connector = await createMercadoLivreConnector();
  } catch {
    redirect("/integracoes/mercado-livre?message=category-api-error");
  }

  const validation = await validateMercadoLivreDiscoveryCategory(
    connector,
    parsed.data.categoryId,
    {
      requireLeaf: false,
    },
  );

  if (!validation.ok) {
    redirect(
      `/integracoes/mercado-livre?message=${validation.message}&categoryId=${encodeURIComponent(parsed.data.categoryId)}`,
    );
  }

  let highlightsAvailable = false;
  let candidatesFound = 0;
  let highlightsReason = "";
  let highlightItemCount = 0;
  let highlightProductCount = 0;
  let highlightUserProductCount = 0;
  let highlightUnknownTypeCount = 0;
  let resolvedItemCandidates = 0;
  let unresolvedCandidates = 0;
  let resolutionReasons = "";
  const productDiagnostics = emptyProductDiagnostics();

  try {
    const highlights = await connector.getBestSellers(validation.category.id);
    const counts = highlightTypeCounts(highlights);
    const resolver = new MercadoLivreHighlightResolver(connector);
    const reasons: Record<string, number> = {};

    highlightsAvailable = highlights.length > 0;
    candidatesFound = highlights.length;
    highlightItemCount = counts.item;
    highlightProductCount = counts.product;
    highlightUserProductCount = counts.userProduct;
    highlightUnknownTypeCount = counts.unknown;
    highlightsReason = highlightsAvailable
      ? "OK"
      : "NO_HIGHLIGHTS_FOR_CATEGORY";

    for (const highlight of highlights) {
      const result = await resolver.resolveCandidate(highlight);
      addProductDiagnostics(productDiagnostics, result.diagnostics);

      if (result.ok) {
        resolvedItemCandidates += 1;
      } else {
        unresolvedCandidates += 1;
        reasons[result.reason] = (reasons[result.reason] ?? 0) + 1;
      }
    }

    resolutionReasons = Object.entries(reasons)
      .map(([reason, count]) => `${reason}:${count}`)
      .join(", ");
  } catch (error) {
    highlightsReason =
      error instanceof MercadoLivreApiError && error.status === 404
        ? "NO_HIGHLIGHTS_FOR_CATEGORY"
        : "CATEGORY_API_ERROR";
  }

  redirect(
    `/integracoes/mercado-livre?${categoryTestQuery({
      message: "category-tested",
      categoryId: validation.category.id,
      categoryName: validation.category.name,
      categoryPath: categoryPath(validation.category),
      categoryLeaf: validation.category.children.length === 0,
      categoryChildrenCount: validation.category.children.length,
      highlightsAvailable,
      candidatesFound,
      highlightsReason,
      highlightItemCount,
      highlightProductCount,
      highlightUserProductCount,
      highlightUnknownTypeCount,
      resolvedItemCandidates,
      unresolvedCandidates,
      resolutionReasons,
      productDirectWinnerCount: productDiagnostics.productDirectWinnerCount,
      productParentCount: productDiagnostics.productParentCount,
      productLeafCount: productDiagnostics.productLeafCount,
      productResolvedDirectly: productDiagnostics.productResolvedDirectly,
      productResolvedViaChild: productDiagnostics.productResolvedViaChild,
      productLeafWithoutWinner: productDiagnostics.productLeafWithoutWinner,
      productParentWithoutResolvableChild:
        productDiagnostics.productParentWithoutResolvableChild,
    })}`,
  );
}

export async function testMercadoLivreIntegrationAction() {
  const config = getMercadoLivreConfig();

  if (!config.clientId || !config.clientSecret || !config.redirectUri) {
    redirect(
      `/integracoes?message=${mercadoLivreFailureMessage("MELI_CONFIGURATION_ERROR")}`,
    );
  }

  const account = await prisma.marketplaceAccount.findFirst({
    where: { marketplace: "MERCADO_LIVRE" },
    orderBy: { updatedAt: "desc" },
    select: { status: true },
  });

  if (!account || account.status !== "CONNECTED") {
    redirect(
      `/integracoes?message=${mercadoLivreFailureMessage("MELI_NOT_CONNECTED")}`,
    );
  }

  let message = "meli-ok";

  try {
    const connector = await createMercadoLivreConnector();
    const available = await connector.healthCheck();

    if (!available) {
      message = mercadoLivreFailureMessage("MELI_API_UNAVAILABLE");
    }
  } catch (error) {
    const code = classifyMercadoLivreTestError(error);
    console.error(
      JSON.stringify({
        event: "mercadolivre_oauth_healthcheck_failed",
        stage: "OAUTH_HEALTHCHECK",
        status: "FAILED",
        errorCode: code,
      }),
    );
    message = mercadoLivreFailureMessage(code);
  }

  redirect(`/integracoes?message=${message}`);
}

export async function syncMercadoLivreNowAction() {
  const result = await collectMercadoLivreCandidates(new Date(), {
    force: true,
  }).catch(() => null);
  const message =
    result?.status === "SUCCEEDED"
      ? "sync-ok"
      : result?.status === "PARTIAL"
        ? "sync-partial"
        : result?.errorCode === "DISCOVERY_ALREADY_RUNNING"
          ? "sync-already-running"
          : result?.errorCode === "DISCOVERY_SOURCE_DISABLED"
            ? "sync-source-disabled"
            : "sync-failed";

  revalidatePath("/integracoes");
  revalidatePath("/integracoes/mercado-livre");
  revalidatePath("/ofertas");

  redirect(`/integracoes/mercado-livre?message=${message}`);
}

function appendCategorySearchAttempt(
  query: URLSearchParams,
  prefix: "probeAuthenticated" | "probePublic",
  attempt?: MercadoLivreCategorySearchProbeAttempt,
) {
  query.set(`${prefix}Attempted`, String(Boolean(attempt)));

  if (!attempt) {
    return;
  }

  query.set(`${prefix}AuthenticationMode`, attempt.authenticationMode);
  query.set(`${prefix}ApiResponded`, String(attempt.httpStatus !== undefined));
  query.set(`${prefix}Ok`, String(attempt.ok));
  query.set(`${prefix}HttpStatus`, attempt.httpStatus?.toString() ?? "");
  query.set(`${prefix}ResultsFound`, String(attempt.resultsFound));
  query.set(`${prefix}UsableItems`, String(attempt.usableItemIds.length));
  query.set(`${prefix}ErrorCode`, attempt.errorCode ?? "");
  query.set(`${prefix}ErrorMessage`, attempt.errorMessage ?? "");
  query.set(`${prefix}MercadoLivreCode`, attempt.apiError?.code ?? "");
  query.set(`${prefix}MercadoLivreError`, attempt.apiError?.error ?? "");
  query.set(`${prefix}Cause`, JSON.stringify(attempt.apiError?.cause ?? []));
  query.set(`${prefix}BlockedBy`, attempt.apiError?.blocked_by ?? "");
  query.set(
    `${prefix}ForbiddenClassification`,
    attempt.forbiddenClassification ?? "",
  );
  query.set(
    `${prefix}Sample`,
    JSON.stringify(
      attempt.sample.map((item) => ({
        itemId: item.itemId,
        title: item.title ?? "",
      })),
    ),
  );
}

export async function probeMercadoLivreCategorySearchAction(
  formData: FormData,
) {
  const parsed = mercadoLivreCategorySchema.safeParse({
    categoryId: formData.get("categoryId")?.toString(),
  });

  if (!parsed.success) {
    redirect("/integracoes/mercado-livre?message=category-invalid");
  }

  let connector: MarketplaceConnector;

  try {
    connector = await createMercadoLivreConnector();
  } catch {
    redirect("/integracoes/mercado-livre?message=category-api-error");
  }

  const validation = await validateMercadoLivreDiscoveryCategory(
    connector,
    parsed.data.categoryId,
    { requireLeaf: true },
  );

  if (!validation.ok) {
    redirect(
      `/integracoes/mercado-livre?message=${validation.message}&categoryId=${encodeURIComponent(parsed.data.categoryId)}`,
    );
  }

  const config = await prisma.mercadoLivreDiscoveryConfig.findFirst({
    orderBy: { updatedAt: "desc" },
    select: { siteId: true },
  });
  const result = await connector.probeCategorySearch({
    siteId: config?.siteId ?? getMercadoLivreConfig().siteId,
    categoryId: validation.category.id,
    limit: 5,
    testPublicAttempt: true,
    shortCircuitOnAuthenticatedSuccess: true,
  });
  const query = new URLSearchParams({
    message: "category-search-tested",
    categoryId: validation.category.id,
    probeCategoryName: validation.category.name,
    probeCategoryPath: categoryPath(validation.category),
    probeMethod: result.method,
    probeEndpoint: result.endpoint,
    probeCategoryParameter: result.parameters.category,
    probeLimitParameter: String(result.parameters.limit),
    probeDiagnosis: result.diagnosis ?? "",
  });

  appendCategorySearchAttempt(
    query,
    "probeAuthenticated",
    result.authenticatedAttempt,
  );
  appendCategorySearchAttempt(query, "probePublic", result.publicAttempt);

  redirect(`/integracoes/mercado-livre?${query.toString()}`);
}

export async function diagnoseMercadoLivreProductAction(formData: FormData) {
  const parsed = mercadoLivreProductSchema.safeParse({
    productId: formData.get("productId")?.toString(),
  });

  if (!parsed.success) {
    redirect("/integracoes/mercado-livre?message=product-diagnostic-invalid");
  }

  let connector: MarketplaceConnector;

  try {
    connector = await createMercadoLivreConnector();
  } catch {
    redirect("/integracoes/mercado-livre?message=product-diagnostic-error");
  }

  let successRedirect: string;

  try {
    const result = await diagnoseMercadoLivreProduct(
      connector,
      parsed.data.productId.toUpperCase(),
    );
    const diagnostics = result.diagnostics;
    const query = new URLSearchParams({
      message: "product-diagnosed",
      productId: result.productId,
      productFound: String(result.productFound),
      productStatus: result.productStatus ?? "",
      productName: result.productName ?? "",
      productPermalink: result.productPermalink ?? "",
      resolvedProductUrl: result.resolvedProductUrl ?? "",
      productUrlSource: result.productUrlSource ?? "",
      productPictureCount: String(result.productPictureCount),
      buyBoxWinnerPresent: String(result.buyBoxWinnerPresent),
      buyBoxWinnerItemId: result.buyBoxWinnerItemId ?? "",
      productItemsHttpStatus:
        diagnostics.productItemsHttpStatus?.toString() ?? "",
      productItemsTotal: String(diagnostics.productItemsTotal),
      productItemsResultsCount: String(diagnostics.productItemsResultsCount),
      productItemsParsedCount: String(diagnostics.productItemsParsedCount),
      productItemsUniqueIds: String(diagnostics.productItemsUniqueIds),
      productItemsHydrationRequested: String(
        diagnostics.productItemsHydrationRequested,
      ),
      productItemsHydrated: String(diagnostics.productItemsHydrated),
      productItemsUsable: String(diagnostics.productItemsUsable),
      selectedItemId: result.selectedItemId ?? "",
      selectedSellerId: result.selectedSellerId ?? "",
      selectedPrice: result.selectedPrice?.toString() ?? "",
      selectedFreeShipping:
        result.selectedFreeShipping === null
          ? ""
          : String(result.selectedFreeShipping),
      itemHydrationAvailable: String(result.itemHydrationAvailable),
      detailEnrichmentStatus: result.detailEnrichmentStatus,
      pdpFallbackEligible: String(result.pdpFallbackEligible),
      resolutionEligible: String(result.resolutionEligible),
      rejectionReasons: JSON.stringify(diagnostics.rejectionReasons),
      diagnosticSamples: JSON.stringify(diagnostics.samples),
    });

    successRedirect = `/integracoes/mercado-livre?${query.toString()}`;
  } catch {
    redirect(
      `/integracoes/mercado-livre?message=product-diagnostic-error&productId=${encodeURIComponent(parsed.data.productId.toUpperCase())}`,
    );
  }

  redirect(successRedirect);
}

export async function saveMercadoLivreAffiliateUrlAction(formData: FormData) {
  const parsed = affiliateLinkSchema.safeParse({
    offerId: formData.get("offerId")?.toString(),
    affiliateUrl: formData.get("affiliateUrl")?.toString(),
    affiliateLabel: formData.get("affiliateLabel")?.toString(),
  });

  if (!parsed.success) {
    redirect("/ofertas/affiliate-links?message=invalid");
  }

  const offer = await prisma.offer.findUnique({
    where: { id: parsed.data.offerId },
  });

  if (!offer || offer.marketplace !== "MERCADO_LIVRE") {
    redirect("/ofertas/affiliate-links?message=not-found");
  }

  const affiliateUrlValidation = validateMarketplaceAffiliateUrl(
    offer.marketplace,
    parsed.data.affiliateUrl,
  );

  if (!affiliateUrlValidation.ok) {
    redirect("/ofertas/affiliate-links?message=invalid");
  }

  const result = await ingestOffer(
    {
      marketplace: offer.marketplace,
      externalProductId: offer.externalProductId,
      title: offer.title,
      description: offer.description ?? undefined,
      category: offer.category ?? undefined,
      imageUrl: offer.imageUrl ?? undefined,
      productUrl: offer.productUrl,
      affiliateUrl: affiliateUrlValidation.normalizedUrl,
      affiliateLabel: parsed.data.affiliateLabel,
      affiliateEligibility: offer.affiliateEligibility,
      sellerId: offer.sellerId ?? undefined,
      officialStoreId: offer.officialStoreId ?? undefined,
      trackingStrategy: "DIRECT_AFFILIATE_LINK",
      originalPrice: decimalToString(offer.originalPrice),
      currentPrice: offer.currentPrice.toString(),
      couponCode: offer.couponCode ?? undefined,
      couponExpiration: offer.couponExpiration ?? undefined,
      commissionPercentage: decimalToString(offer.commissionPercentage),
      rating: decimalToString(offer.rating),
      salesCount: offer.salesCount ?? undefined,
      shippingStatus: offer.shippingStatus,
      stockStatus: offer.stockStatus,
    },
    {
      minScore: offer.minimumScoreApplied,
    },
  );

  if (result.ok && result.offerId !== offer.id) {
    await prisma.offer.update({
      where: { id: offer.id },
      data: {
        status: "REJECTED_DUPLICATE",
        statusReason:
          "Substituida por versao validada com link oficial de afiliado.",
      },
    });
  }

  revalidatePath("/ofertas");
  revalidatePath("/ofertas/affiliate-links");
  redirect(
    `/ofertas/affiliate-links?message=${result.ok ? "saved" : "failed"}`,
  );
}

export type AffiliateLinkBatchActionInput =
  | {
      method: "PIPE" | "CSV";
      raw: string;
    }
  | {
      method: "ENTRIES";
      entries: AffiliateLinkBatchEntry[];
    };

function parseAffiliateLinkBatchInput(input: AffiliateLinkBatchActionInput) {
  if (input.method === "ENTRIES") {
    return { entries: input.entries, issues: [] };
  }

  return input.method === "CSV"
    ? parseAffiliateLinksCsv(input.raw)
    : parsePipeAffiliateLinks(input.raw);
}

export async function previewAffiliateLinksBatchAction(
  input: AffiliateLinkBatchActionInput,
) {
  const parsed = parseAffiliateLinkBatchInput(input);
  const preview = await previewAffiliateLinksBatch(parsed.entries);

  return { parseIssues: parsed.issues, preview };
}

export async function applyAffiliateLinksBatchAction(
  input: AffiliateLinkBatchActionInput,
) {
  const parsed = parseAffiliateLinkBatchInput(input);

  if (parsed.issues.length > 0) {
    return {
      ok: false as const,
      parseIssues: parsed.issues,
      result: null,
    };
  }

  const inlineLimit = Math.max(
    1,
    Math.floor(Number(process.env.AFFILIATE_LINK_JOB_INLINE_LIMIT ?? 50)),
  );
  const result =
    parsed.entries.length > inlineLimit
      ? await queueAffiliateLinksBatch(parsed.entries)
      : await applyAffiliateLinksBatch({ entries: parsed.entries });
  revalidatePath("/ofertas");
  revalidatePath("/ofertas/affiliate-links");
  revalidatePath("/integracoes/mercado-livre");

  return { ok: true as const, parseIssues: [], result };
}

export async function acknowledgeAlertAction(formData: FormData) {
  const id = formData.get("id")?.toString();

  if (!id) {
    throw new Error("Alerta nao informado.");
  }

  await prisma.systemAlert.update({
    where: { id },
    data: { acknowledged: true },
  });
  revalidatePath("/logs");
}

export async function updateWorkerPauseAction(formData: FormData) {
  const scope = formData.get("scope")?.toString();
  const paused = formData.get("paused")?.toString() === "true";

  if (scope !== "discovery" && scope !== "publication") {
    throw new Error("Controle de automacao invalido.");
  }

  const existing = await prisma.systemSetting.findUnique({
    where: { key: WORKER_CONTROLS_KEY },
    select: { value: true },
  });
  const controls = workerControlsFromValue(existing?.value);
  const next = {
    ...controls,
    ...(scope === "discovery"
      ? { discoveryPaused: paused }
      : { publicationPaused: paused }),
  };

  await prisma.systemSetting.upsert({
    where: { key: WORKER_CONTROLS_KEY },
    update: { value: next },
    create: { key: WORKER_CONTROLS_KEY, value: next },
  });

  revalidatePath("/automacoes");
}
