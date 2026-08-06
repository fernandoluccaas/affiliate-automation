"use server";

import { z } from "zod";
import {
  collectMercadoLivreCandidates,
  generatePendingMercadoLivreAffiliateLinks,
} from "@affiliate/marketplace-discovery";
import type {
  InteractiveActionResult,
  MercadoLivreAffiliateLinkTestDto,
  MercadoLivreAffiliateSessionActionDto,
  MercadoLivreCategoryBrowserDto,
  MercadoLivreCategorySearchProbeDto,
  MercadoLivreCategoryTestDto,
  MercadoLivreDiscoveryConfigDto,
  MercadoLivreImportSummaryDto,
  MercadoLivrePendingLinksDto,
  MercadoLivreProductDiagnosticDto,
  MercadoLivreProductPdpAffiliateDiagnosticDto,
} from "@/app/integracoes/mercado-livre/mercado-livre-interactive-types";
import {
  clearMercadoLivreAffiliateSession,
  generateMercadoLivreAffiliateTestLink,
  saveMercadoLivreAffiliateSession,
  selectMercadoLivreAffiliateTag,
  testMercadoLivreAffiliateSession,
  type MercadoLivreAffiliateSessionResult,
} from "./mercadolivre-affiliate-session";
import {
  MercadoLivreInteractiveServiceError,
  addMercadoLivreDiscoveryCategory,
  getMercadoLivreCategoryBrowserData,
  saveMercadoLivreDiscoveryConfig,
  testMercadoLivreDiscoveryCategory,
} from "./mercadolivre-interactive-service";
import {
  diagnoseMercadoLivreProductInteractive,
  diagnoseMercadoLivreProductPdpAffiliateInteractive,
  probeMercadoLivreCategorySearchInteractive,
} from "./mercadolivre-interactive-diagnostics-service";
import { requireSession } from "./session";

const categoryInputSchema = z.object({
  categoryId: z.string().trim().min(1).max(100).nullable().optional(),
});

const affiliateSessionSchema = z.object({
  sampleAffiliateLink: z.preprocess(
    emptyToUndefined,
    z.string().trim().url().max(2_048).optional(),
  ),
  cookie: z.preprocess(
    emptyToUndefined,
    z.string().trim().min(1).max(65_535).optional(),
  ),
  affiliateTag: z.preprocess(
    emptyToUndefined,
    z.string().trim().min(1).max(200).optional(),
  ),
});

const affiliateTagSchema = z.object({
  affiliateTag: z.string().trim().min(1).max(200),
});

const affiliateTestLinkSchema = z.object({
  productUrl: z.string().trim().url().max(2_048),
  affiliateTag: z.preprocess(
    emptyToUndefined,
    z.string().trim().min(1).max(200).optional(),
  ),
});

const pendingLinksSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(50),
});

const productDiagnosticSchema = z.object({
  productId: z
    .string()
    .trim()
    .regex(/^MLB\d+$/i),
});

function emptyToUndefined(value: unknown) {
  return value === "" || value === null ? undefined : value;
}

async function authorize() {
  const user = await requireSession();
  if (user.role === "VIEWER") {
    throw new MercadoLivreInteractiveServiceError(
      "NOT_AUTHORIZED",
      "Seu perfil não pode alterar esta integração.",
    );
  }
  return user;
}

async function authenticate() {
  return requireSession();
}

function failure<T>(error: unknown): InteractiveActionResult<T> {
  if (error instanceof z.ZodError) {
    return {
      ok: false,
      errorCode: "INPUT_INVALID",
      message: "Revise os dados informados.",
    };
  }
  if (error instanceof MercadoLivreInteractiveServiceError) {
    return {
      ok: false,
      errorCode: error.code,
      message: error.message,
      ...(error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}),
    };
  }
  return {
    ok: false,
    errorCode: "UNEXPECTED_ERROR",
    message: "A operação não pôde ser concluída. Tente novamente.",
  };
}

export async function getMercadoLivreCategoryChildrenAction(
  input: unknown,
): Promise<InteractiveActionResult<MercadoLivreCategoryBrowserDto>> {
  try {
    await authenticate();
    const parsed = categoryInputSchema.parse(input);
    const data = await getMercadoLivreCategoryBrowserData(parsed.categoryId);
    return { ok: true, data, message: "Categorias atualizadas." };
  } catch (error) {
    return failure(error);
  }
}

export async function getMercadoLivreCategoryDetailsAction(
  input: unknown,
): Promise<InteractiveActionResult<MercadoLivreCategoryBrowserDto>> {
  return getMercadoLivreCategoryChildrenAction(input);
}

export async function testMercadoLivreCategoryInteractiveAction(
  input: unknown,
): Promise<InteractiveActionResult<MercadoLivreCategoryTestDto>> {
  try {
    await authenticate();
    const parsed = categoryInputSchema
      .extend({ categoryId: z.string().trim().min(1).max(100) })
      .parse(input);
    const data = await testMercadoLivreDiscoveryCategory(parsed.categoryId);
    return { ok: true, data, message: "Teste da categoria concluído." };
  } catch (error) {
    return failure(error);
  }
}

export async function addMercadoLivreCategoryInteractiveAction(
  input: unknown,
): Promise<
  InteractiveActionResult<
    Awaited<ReturnType<typeof addMercadoLivreDiscoveryCategory>>
  >
> {
  try {
    await authorize();
    const parsed = categoryInputSchema
      .extend({ categoryId: z.string().trim().min(1).max(100) })
      .parse(input);
    const data = await addMercadoLivreDiscoveryCategory(parsed.categoryId);
    return {
      ok: true,
      data,
      message: data.alreadyConfigured
        ? "Categoria já adicionada."
        : "Categoria adicionada.",
    };
  } catch (error) {
    return failure(error);
  }
}

export async function saveMercadoLivreConfigInteractiveAction(
  formData: FormData,
): Promise<InteractiveActionResult<MercadoLivreDiscoveryConfigDto>> {
  try {
    await authorize();
    const data = await saveMercadoLivreDiscoveryConfig(formData);
    return { ok: true, data, message: "Configuração salva." };
  } catch (error) {
    return failure(error);
  }
}

function affiliateSessionDto(
  result: MercadoLivreAffiliateSessionResult,
): MercadoLivreAffiliateSessionActionDto {
  return {
    code: result.code,
    status: result.status,
    affiliateTag: result.affiliateTag ?? null,
    availableTags: (result.availableTags ?? []).map((tag) => ({
      value: tag.value,
      label: tag.label,
      isDefault: tag.isDefault,
    })),
  };
}

function affiliateFailure<T>(
  result: MercadoLivreAffiliateSessionResult,
): InteractiveActionResult<T> {
  return {
    ok: false,
    errorCode: result.code,
    message:
      result.status === "EXPIRED"
        ? "A sessão de afiliado expirou. Atualize o cookie manualmente."
        : "Não foi possível concluir a operação da sessão de afiliado.",
  };
}

async function runAffiliateSessionOperation(
  operation: () => Promise<MercadoLivreAffiliateSessionResult>,
): Promise<InteractiveActionResult<MercadoLivreAffiliateSessionActionDto>> {
  try {
    const result = await operation();
    if (!result.ok) return affiliateFailure(result);
    return {
      ok: true,
      data: affiliateSessionDto(result),
      message: "Operação da sessão concluída.",
    };
  } catch (error) {
    return failure(error);
  }
}

export async function saveMercadoLivreAffiliateSessionInteractiveAction(
  formData: FormData,
): Promise<InteractiveActionResult<MercadoLivreAffiliateSessionActionDto>> {
  try {
    await authorize();
    const parsed = affiliateSessionSchema.parse({
      sampleAffiliateLink: formData.get("sampleAffiliateLink"),
      cookie: formData.get("cookie"),
      affiliateTag: formData.get("affiliateTag"),
    });
    return runAffiliateSessionOperation(() =>
      saveMercadoLivreAffiliateSession(parsed),
    );
  } catch (error) {
    return failure(error);
  }
}

export async function testMercadoLivreAffiliateSessionInteractiveAction(): Promise<
  InteractiveActionResult<MercadoLivreAffiliateSessionActionDto>
> {
  try {
    await authorize();
    return runAffiliateSessionOperation(testMercadoLivreAffiliateSession);
  } catch (error) {
    return failure(error);
  }
}

export async function clearMercadoLivreAffiliateSessionInteractiveAction(): Promise<
  InteractiveActionResult<MercadoLivreAffiliateSessionActionDto>
> {
  try {
    await authorize();
    return runAffiliateSessionOperation(clearMercadoLivreAffiliateSession);
  } catch (error) {
    return failure(error);
  }
}

export async function selectMercadoLivreAffiliateTagInteractiveAction(
  input: unknown,
): Promise<InteractiveActionResult<MercadoLivreAffiliateSessionActionDto>> {
  try {
    await authorize();
    const parsed = affiliateTagSchema.parse(input);
    return runAffiliateSessionOperation(() =>
      selectMercadoLivreAffiliateTag(parsed.affiliateTag),
    );
  } catch (error) {
    return failure(error);
  }
}

export async function generateMercadoLivreAffiliateTestLinkInteractiveAction(
  input: unknown,
): Promise<InteractiveActionResult<MercadoLivreAffiliateLinkTestDto>> {
  try {
    await authorize();
    const parsed = affiliateTestLinkSchema.parse(input);
    const result = await generateMercadoLivreAffiliateTestLink({
      productUrl: parsed.productUrl,
      ...(parsed.affiliateTag ? { affiliateTag: parsed.affiliateTag } : {}),
    });
    if (!result.ok || !result.affiliateUrl) return affiliateFailure(result);
    return {
      ok: true,
      data: {
        affiliateUrl: result.affiliateUrl,
        provider: result.provider ?? "stripe_v2",
        generatedAt:
          result.generatedAt?.toISOString() ?? new Date().toISOString(),
      },
      message: "Link meli.la de teste gerado.",
    };
  } catch (error) {
    return failure(error);
  }
}

export async function generatePendingMercadoLivreAffiliateLinksInteractiveAction(
  input: unknown,
): Promise<InteractiveActionResult<MercadoLivrePendingLinksDto>> {
  try {
    await authorize();
    const parsed = pendingLinksSchema.parse(input);
    const result = await generatePendingMercadoLivreAffiliateLinks({
      limit: parsed.limit,
    });
    if (!result.ok) {
      return {
        ok: false,
        errorCode: result.errorCode ?? "AFFILIATE_LINK_BATCH_FAILED",
        message: "Não foi possível gerar os links pendentes.",
      };
    }
    const data: MercadoLivrePendingLinksDto = {
      status: result.status,
      selected: result.selected,
      processed: result.processed,
      linksGenerated: result.linksGenerated,
      updated: result.updated,
      ineligible: result.ineligible,
      pending: result.pending,
      failed: result.failed,
    };
    return {
      ok: true,
      data,
      message:
        result.selected === 0
          ? "Nenhuma oferta pendente encontrada."
          : result.status === "PARTIAL"
            ? "Geração concluída parcialmente."
            : "Links pendentes gerados.",
    };
  } catch (error) {
    return failure(error);
  }
}

export async function diagnoseMercadoLivreProductInteractiveAction(
  input: unknown,
): Promise<InteractiveActionResult<MercadoLivreProductDiagnosticDto>> {
  try {
    await authenticate();
    const parsed = productDiagnosticSchema.parse(input);
    const data = await diagnoseMercadoLivreProductInteractive(parsed.productId);
    return { ok: true, data, message: "Diagnóstico do PRODUCT concluído." };
  } catch (error) {
    return failure(error);
  }
}

export async function probeMercadoLivreCategorySearchInteractiveAction(
  input: unknown,
): Promise<InteractiveActionResult<MercadoLivreCategorySearchProbeDto>> {
  try {
    await authenticate();
    const parsed = categoryInputSchema
      .extend({ categoryId: z.string().trim().min(1).max(100) })
      .parse(input);
    const data = await probeMercadoLivreCategorySearchInteractive(
      parsed.categoryId,
    );
    return { ok: true, data, message: "Probe da categoria concluído." };
  } catch (error) {
    return failure(error);
  }
}

export async function syncMercadoLivreNowInteractiveAction(): Promise<
  InteractiveActionResult<MercadoLivreImportSummaryDto>
> {
  try {
    await authorize();
    const result = await collectMercadoLivreCandidates(new Date(), {
      force: true,
    });
    const data: MercadoLivreImportSummaryDto = {
      status: result.status,
      candidatesFound: result.metrics.candidatesFound,
      resolvedItemCandidates: result.metrics.resolvedItemCandidates,
      newProducts: result.metrics.newProducts,
      newOfferVersions: result.metrics.newOfferVersions,
      updatedOffers: result.metrics.updatedOffers,
      readyToPublish: result.metrics.readyToPublish,
      readyForAffiliateLink: result.metrics.readyForAffiliateLink,
      affiliateLinksGenerated: result.metrics.affiliateLinksGenerated,
      affiliateLinksReused: result.metrics.affiliateLinksReused,
      errors: result.metrics.errors,
    };
    if (!result.ok) {
      return {
        ok: false,
        errorCode: result.errorCode ?? "DISCOVERY_FAILED",
        message:
          result.errorCode === "DISCOVERY_ALREADY_RUNNING"
            ? "Uma importação já está em andamento."
            : result.errorCode === "DISCOVERY_SOURCE_DISABLED"
              ? "A descoberta do Mercado Livre está desabilitada."
              : "Não foi possível concluir a importação.",
      };
    }
    return {
      ok: true,
      data,
      message:
        result.status === "PARTIAL"
          ? "Importação concluída parcialmente."
          : "Importação concluída.",
    };
  } catch (error) {
    return failure(error);
  }
}

export async function testMercadoLivreProductPdpAffiliateInteractiveAction(
  input: unknown,
): Promise<
  InteractiveActionResult<MercadoLivreProductPdpAffiliateDiagnosticDto>
> {
  try {
    await authorize();
    const parsed = productDiagnosticSchema.parse(input);
    const data = await diagnoseMercadoLivreProductPdpAffiliateInteractive(
      parsed.productId,
    );
    return {
      ok: true,
      data,
      message: "Teste afiliado do PRODUCT concluído.",
    };
  } catch (error) {
    return failure(error);
  }
}
