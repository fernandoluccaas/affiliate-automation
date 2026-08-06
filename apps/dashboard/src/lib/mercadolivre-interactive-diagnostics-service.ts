import "server-only";

import { prisma } from "@affiliate/database";
import {
  createMercadoLivreConnector,
  getMercadoLivreConfig,
  resolveMercadoLivreCatalogProductUrl,
  type MercadoLivreCategorySearchProbeAttempt,
} from "@affiliate/marketplace-connectors";
import { diagnoseMercadoLivreProduct } from "@affiliate/marketplace-discovery";
import type {
  MercadoLivreCategorySearchProbeDto,
  MercadoLivreProductDiagnosticDto,
  MercadoLivreProductPdpAffiliateDiagnosticDto,
} from "@/app/integracoes/mercado-livre/mercado-livre-interactive-types";
import { generateMercadoLivreAffiliateTestLink } from "./mercadolivre-affiliate-session";
import { MercadoLivreInteractiveServiceError } from "./mercadolivre-interactive-service";

function categoryPath(path: Array<{ name: string }>) {
  return path
    .map((item) => item.name)
    .filter(Boolean)
    .join(" > ");
}

export async function diagnoseMercadoLivreProductInteractive(
  productId: string,
): Promise<MercadoLivreProductDiagnosticDto> {
  try {
    const connector = await createMercadoLivreConnector();
    const result = await diagnoseMercadoLivreProduct(
      connector,
      productId.toUpperCase(),
    );
    const diagnostics = result.diagnostics;
    return {
      productId: result.productId,
      productFound: result.productFound,
      productStatus: result.productStatus ?? null,
      productName: result.productName ?? null,
      productPermalink: result.productPermalink ?? null,
      resolvedProductUrl: result.resolvedProductUrl ?? null,
      productUrlSource: result.productUrlSource ?? null,
      productPictureCount: result.productPictureCount,
      buyBoxWinnerPresent: result.buyBoxWinnerPresent,
      buyBoxWinnerItemId: result.buyBoxWinnerItemId ?? null,
      selectedItemId: result.selectedItemId ?? null,
      selectedSellerId: result.selectedSellerId ?? null,
      selectedPrice: result.selectedPrice?.toString() ?? null,
      selectedFreeShipping: result.selectedFreeShipping,
      detailEnrichmentStatus: result.detailEnrichmentStatus,
      pdpFallbackEligible: result.pdpFallbackEligible,
      resolutionEligible: result.resolutionEligible,
      rejectionReasons: Object.entries(diagnostics.rejectionReasons).map(
        ([reason, count]) => `${reason}:${count}`,
      ),
      counts: {
        productItemsTotal: diagnostics.productItemsTotal,
        productItemsResultsCount: diagnostics.productItemsResultsCount,
        productItemsParsedCount: diagnostics.productItemsParsedCount,
        productItemsUniqueIds: diagnostics.productItemsUniqueIds,
        productItemsHydrationRequested:
          diagnostics.productItemsHydrationRequested,
        productItemsHydrated: diagnostics.productItemsHydrated,
        productItemsUsable: diagnostics.productItemsUsable,
      },
    };
  } catch {
    throw new MercadoLivreInteractiveServiceError(
      "PRODUCT_DIAGNOSTIC_ERROR",
      "Não foi possível diagnosticar este PRODUCT.",
    );
  }
}

function attemptDto(attempt?: MercadoLivreCategorySearchProbeAttempt) {
  return {
    attempted: Boolean(attempt),
    ok: attempt?.ok ?? false,
    httpStatus: attempt?.httpStatus ?? null,
    resultsFound: attempt?.resultsFound ?? 0,
    usableItems: attempt?.usableItemIds.length ?? 0,
    errorCode: attempt?.errorCode ?? null,
  };
}

export async function probeMercadoLivreCategorySearchInteractive(
  categoryId: string,
): Promise<MercadoLivreCategorySearchProbeDto> {
  try {
    const connector = await createMercadoLivreConnector();
    const category = await connector.getCategory(categoryId);
    if (!category) {
      throw new MercadoLivreInteractiveServiceError(
        "CATEGORY_NOT_FOUND",
        "Categoria não encontrada.",
      );
    }
    if (category.children.length > 0) {
      throw new MercadoLivreInteractiveServiceError(
        "CATEGORY_NOT_LEAF",
        "Selecione uma categoria folha.",
      );
    }
    const config = await prisma.mercadoLivreDiscoveryConfig.findFirst({
      orderBy: { updatedAt: "desc" },
      select: { siteId: true },
    });
    const result = await connector.probeCategorySearch({
      siteId: config?.siteId ?? getMercadoLivreConfig().siteId,
      categoryId: category.id,
      limit: 5,
      testPublicAttempt: true,
      shortCircuitOnAuthenticatedSuccess: true,
    });
    return {
      categoryId: category.id,
      categoryName: category.name,
      categoryPath: categoryPath(category.pathFromRoot),
      method: result.method,
      endpoint: result.endpoint,
      categoryParameter: result.parameters.category,
      limit: result.parameters.limit,
      diagnosis: result.diagnosis ?? null,
      authenticated: attemptDto(result.authenticatedAttempt),
      public: attemptDto(result.publicAttempt),
    };
  } catch (error) {
    if (error instanceof MercadoLivreInteractiveServiceError) throw error;
    throw new MercadoLivreInteractiveServiceError(
      "CATEGORY_SEARCH_PROBE_ERROR",
      "Não foi possível executar o diagnóstico da categoria.",
    );
  }
}

export async function diagnoseMercadoLivreProductPdpAffiliateInteractive(
  productId: string,
): Promise<MercadoLivreProductPdpAffiliateDiagnosticDto> {
  try {
    const connector = await createMercadoLivreConnector();
    const normalizedProductId = productId.toUpperCase();
    const product = await connector.getProduct(normalizedProductId);
    if (!product) {
      throw new MercadoLivreInteractiveServiceError(
        "PRODUCT_NOT_FOUND",
        "PRODUCT não encontrado.",
      );
    }
    const resolved = resolveMercadoLivreCatalogProductUrl({
      productId: product.id,
      productPermalink: product.permalink,
      productStatus: product.status,
    });
    if (!resolved) {
      throw new MercadoLivreInteractiveServiceError(
        "PRODUCT_PDP_URL_UNAVAILABLE",
        "O PRODUCT não possui uma URL pública elegível.",
      );
    }
    const generated = await generateMercadoLivreAffiliateTestLink({
      productUrl: resolved.productUrl,
    });
    if (!generated.ok || !generated.affiliateUrl) {
      throw new MercadoLivreInteractiveServiceError(
        generated.code,
        "Não foi possível gerar o link afiliado para este PRODUCT.",
      );
    }
    const url = new URL(generated.affiliateUrl);
    return {
      productId: normalizedProductId,
      endpointMode: generated.provider ?? "stripe_v2",
      affiliateHost: url.hostname,
      startsWithMeliLa: generated.affiliateUrl.startsWith("https://meli.la/"),
      productUrlSource: resolved.source,
    };
  } catch (error) {
    if (error instanceof MercadoLivreInteractiveServiceError) throw error;
    throw new MercadoLivreInteractiveServiceError(
      "PRODUCT_PDP_AFFILIATE_ERROR",
      "Não foi possível testar o link afiliado deste PRODUCT.",
    );
  }
}
