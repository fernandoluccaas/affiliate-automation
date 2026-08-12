"use server";

import { z } from "zod";
import {
  SHOPEE_CATEGORY_CATALOG,
  inspectShopeeDatafeeds,
  previewShopeeDatafeeds,
  resolveShopeeAffiliateConfiguration,
  type ShopeeCategoryRule,
  type ShopeeLogicalCategory,
} from "@affiliate/shopee-affiliate";
import type {
  ShopeeDatafeedActionInput,
  ShopeeInspectActionResult,
  ShopeePreviewActionResult,
} from "@/app/integracoes/shopee/shopee-types";
import { requireSession } from "./session";

const nullableNumber = z.number().finite().nullable();
const inputSchema = z.object({
  files: z.array(z.string().trim().min(1).max(4_096)).min(1).max(2),
  categories: z
    .array(
      z.object({
        id: z.enum([
          "CELULARES",
          "CASA",
          "MODA",
          "RELOGIOS",
          "AUTOMOTIVO",
          "ELETRODOMESTICOS",
        ]),
        enabled: z.boolean(),
        priority: z.number().int().min(-100).max(100),
        minPerCategory: z.number().int().min(0).max(2),
        maxPerCategory: z.number().int().min(1).max(10),
      }),
    )
    .length(6),
  filters: z.object({
    priceMin: nullableNumber,
    priceMax: nullableNumber,
    discountMin: nullableNumber,
    itemRatingMin: nullableNumber,
    shopRatingMin: nullableNumber,
    crossBorderAllowed: z.boolean(),
    forbiddenWords: z.array(z.string().trim().min(1).max(80)).max(50),
  }),
});

async function authorize() {
  const user = await requireSession();
  if (user.role === "VIEWER") throw new Error("SHOPEE_NOT_AUTHORIZED");
}

function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  return /^SHOPEE_[A-Z0-9_]+$/.test(message)
    ? message
    : "SHOPEE_DATAFEED_OPERATION_FAILED";
}

function messageFor(code: string) {
  const messages: Record<string, string> = {
    SHOPEE_DATAFEED_MODE_REQUIRED:
      "Ative explicitamente o modo DATAFEED para executar esta ação.",
    SHOPEE_DATAFEED_FILE_NOT_FOUND: "O arquivo informado não foi encontrado.",
    SHOPEE_DATAFEED_FILE_TOO_LARGE: "O arquivo excede o limite configurado.",
    SHOPEE_DATAFEED_SCHEMA_UNSUPPORTED:
      "O cabeçalho não corresponde a um dos dois schemas oficiais conhecidos.",
    SHOPEE_DATAFEED_ALREADY_PROCESSING:
      "Este arquivo já está sendo processado por outra operação.",
    SHOPEE_NOT_AUTHORIZED: "Seu perfil não pode ler arquivos do servidor.",
  };
  return (
    messages[code] ?? "Não foi possível processar o Datafeed com segurança."
  );
}

function categoriesFromInput(
  input: z.infer<typeof inputSchema>,
): ShopeeCategoryRule[] {
  const overrides = new Map(
    input.categories.map((category) => [category.id, category]),
  );
  return SHOPEE_CATEGORY_CATALOG.map((category) => {
    const override = overrides.get(category.id);
    return {
      ...category,
      enabled: override?.enabled ?? category.enabled,
      priority: override?.priority ?? category.priority,
      minPerCategory: override?.minPerCategory ?? category.minPerCategory,
      maxPerCategory: override?.maxPerCategory ?? category.maxPerCategory,
    } as ShopeeCategoryRule;
  });
}

async function parseAuthorized(input: ShopeeDatafeedActionInput) {
  await authorize();
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new Error("SHOPEE_DATAFEED_INPUT_INVALID");
  const configuration = resolveShopeeAffiliateConfiguration();
  if (configuration.mode !== "DATAFEED") {
    throw new Error("SHOPEE_DATAFEED_MODE_REQUIRED");
  }
  return parsed.data;
}

export async function inspectShopeeDatafeedAction(
  input: ShopeeDatafeedActionInput,
): Promise<ShopeeInspectActionResult> {
  try {
    const parsed = await parseAuthorized(input);
    const data = await inspectShopeeDatafeeds({ files: parsed.files });
    return {
      ok: true,
      data,
      message: "Datafeed inspecionado sem alterar dados.",
    };
  } catch (error) {
    const errorCode = safeError(error);
    return { ok: false, errorCode, message: messageFor(errorCode) };
  }
}

export async function previewShopeeDatafeedAction(
  input: ShopeeDatafeedActionInput,
): Promise<ShopeePreviewActionResult> {
  try {
    const parsed = await parseAuthorized(input);
    const data = await previewShopeeDatafeeds({
      files: parsed.files,
      categories: categoriesFromInput(parsed),
      filters: parsed.filters,
    });
    return {
      ok: true,
      data,
      message: `Preview concluído com ${data.selected.length} vencedor(es), sem gravações.`,
    };
  } catch (error) {
    const errorCode = safeError(error);
    return { ok: false, errorCode, message: messageFor(errorCode) };
  }
}

export type { ShopeeLogicalCategory };
