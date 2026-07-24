"use server";

import { Prisma, prisma } from "@affiliate/database";
import { MessageGenerationService } from "@affiliate/ai-copywriter";
import bcrypt from "bcryptjs";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { TelegramPublisher } from "@affiliate/publisher-connectors";
import { createSession, destroySession } from "./session";
import { ingestOffer } from "./offer-ingest";
import { offerFormSchema, type OfferFormValues } from "./offer-form-schema";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export type LoginState = {
  error?: string;
};

export async function loginAction(_state: LoginState, formData: FormData): Promise<LoginState> {
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

  const passwordMatches = await bcrypt.compare(parsed.data.password, user.passwordHash);

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

export async function createManualOfferAction(input: OfferFormValues): Promise<CreateOfferState> {
  const parsed = offerFormSchema.safeParse(input);

  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? "Dados da oferta invalidos.",
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
  type: z.enum(["TELEGRAM", "MANUAL_EXPORT", "WHATSAPP_CLOUD_API", "WHATSAPP_GROUPS_API"]),
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
  });

  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Dados do canal invalidos.");
  }

  const channel = parsed.data;
  const configuration =
    channel.type === "TELEGRAM" && channel.telegramChatId
      ? { chatId: channel.telegramChatId.trim() }
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
  const { data } = channelPayload(formData);
  await prisma.channel.create({ data });
  revalidatePath("/canais");
  redirect("/canais?message=created");
}

export async function updateChannelAction(formData: FormData) {
  const { channel, data } = channelPayload(formData);

  if (!channel.id) {
    throw new Error("Canal nao informado.");
  }

  await prisma.channel.update({ where: { id: channel.id }, data });
  revalidatePath("/canais");
  redirect("/canais?message=updated");
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
    channel.configuration && typeof channel.configuration === "object" && !Array.isArray(channel.configuration)
      ? (channel.configuration as Record<string, unknown>)
      : {};
  const publisher = new TelegramPublisher({
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: typeof configuration.chatId === "string" ? configuration.chatId : process.env.TELEGRAM_CHAT_ID,
  });
  const ok = await publisher.validateCredentials();

  redirect(`/canais?message=${ok ? "telegram-ok" : "telegram-failed"}`);
}

export async function testOpenAiCopyAction() {
  const service = new MessageGenerationService();
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

export async function acknowledgeAlertAction(formData: FormData) {
  const id = formData.get("id")?.toString();

  if (!id) {
    throw new Error("Alerta nao informado.");
  }

  await prisma.systemAlert.update({ where: { id }, data: { acknowledged: true } });
  revalidatePath("/logs");
}
