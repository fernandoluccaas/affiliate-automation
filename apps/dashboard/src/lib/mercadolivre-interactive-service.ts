import "server-only";

import { prisma } from "@affiliate/database";
import {
  MercadoLivreApiError,
  createMercadoLivreConnector,
  getMercadoLivreConfig,
  type MercadoLivreCategory,
  type MercadoLivreHighlightCandidate,
} from "@affiliate/marketplace-connectors";
import {
  MercadoLivreHighlightResolver,
  type MercadoLivreProductResolutionDiagnostics,
} from "@affiliate/marketplace-discovery";
import { z } from "zod";
import type {
  MercadoLivreCategoryBrowserDto,
  MercadoLivreCategoryDto,
  MercadoLivreCategoryTestDto,
  MercadoLivreConfiguredCategoryDto,
  MercadoLivreDiscoveryConfigDto,
} from "@/app/integracoes/mercado-livre/mercado-livre-interactive-types";

const categorySchema = z.string().trim().min(1).max(100);

const configSchema = z.object({
  enabled: z.boolean(),
  siteId: z.string().trim().min(1),
  categoryIds: z.string().optional(),
  bestSellersEnabled: z.boolean(),
  minimumPrice: optionalPositiveNumber(),
  maximumPrice: optionalPositiveNumber(),
  minimumDiscountPercentage: z.preprocess(
    emptyToUndefined,
    z.coerce.number().min(0).max(100).optional(),
  ),
  minimumScore: z.coerce.number().int().min(0).max(100),
  maxCandidatesPerCategory: z.coerce.number().int().min(1).max(20),
  refreshIntervalMinutes: z.coerce.number().int().min(15),
  multiCategoryEnabled: z.boolean(),
  multiCategoryMinOffersPerCategory: z.coerce.number().int().min(0).max(2),
  multiCategoryMaxOffersPerCategory: z.coerce.number().int().min(1).max(10),
  multiCategoryMaxTotalPerSession: z.coerce.number().int().min(1).max(100),
  multiCategorySelectionMode: z.literal("ROUND_ROBIN"),
  multiCategoryAllowCategoryBackfill: z.boolean(),
});

function emptyToUndefined(value: unknown) {
  return value === "" || value === null ? undefined : value;
}

function optionalPositiveNumber() {
  return z.preprocess(
    emptyToUndefined,
    z.coerce.number().positive().optional(),
  );
}

export class MercadoLivreInteractiveServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly fieldErrors?: Record<string, string>,
  ) {
    super(message);
  }
}

function unique(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function stringList(value?: string) {
  return unique(value?.split(",") ?? []);
}

export function mercadoLivreCategoryDto(
  category: MercadoLivreCategory,
): MercadoLivreCategoryDto {
  const path =
    category.pathFromRoot.length > 0
      ? category.pathFromRoot
      : [{ id: category.id, name: category.name }];
  return {
    id: category.id,
    name: category.name,
    path: path.map((item) => ({ id: item.id, name: item.name })),
    childrenCount: category.children.length,
    isLeaf: category.children.length === 0,
  };
}

async function connectorOrThrow() {
  try {
    return await createMercadoLivreConnector();
  } catch {
    throw new MercadoLivreInteractiveServiceError(
      "CATEGORY_API_ERROR",
      "Não foi possível conectar à API oficial do Mercado Livre.",
    );
  }
}

async function categoryOrThrow(categoryId: string) {
  const parsed = categorySchema.safeParse(categoryId);
  if (!parsed.success) {
    throw new MercadoLivreInteractiveServiceError(
      "CATEGORY_INVALID",
      "Informe uma categoria válida.",
      { categoryId: "Informe uma categoria válida." },
    );
  }
  const connector = await connectorOrThrow();
  try {
    const category = await connector.getCategory(parsed.data);
    if (!category) throw new Error("not-found");
    return { connector, category };
  } catch (error) {
    throw new MercadoLivreInteractiveServiceError(
      error instanceof MercadoLivreApiError && error.status !== 404
        ? "CATEGORY_API_ERROR"
        : "CATEGORY_NOT_FOUND",
      error instanceof MercadoLivreApiError && error.status !== 404
        ? "Não foi possível consultar esta categoria."
        : "Categoria não encontrada.",
    );
  }
}

async function configuredCategoryDtos(
  connector: Awaited<ReturnType<typeof createMercadoLivreConnector>> | null,
) {
  const config = await prisma.mercadoLivreDiscoveryConfig.findFirst({
    orderBy: { updatedAt: "desc" },
    select: { categoryIds: true, multiCategorySettings: true },
  });
  const ids = Array.isArray(config?.categoryIds)
    ? config.categoryIds.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  const settings = Array.isArray(config?.multiCategorySettings)
    ? (config.multiCategorySettings as Array<{
        categoryId: string;
        name?: string | null;
        enabled?: boolean;
        priority?: number;
        minOffers?: number | null;
        maxOffers?: number | null;
      }>)
    : [];
  return Promise.all(
    unique(ids).map(async (id): Promise<MercadoLivreConfiguredCategoryDto> => {
      const details = connector
        ? await connector.getCategory(id).catch(() => null)
        : null;
      const setting = settings.find((entry) => entry.categoryId === id);
      const dto = details
        ? mercadoLivreCategoryDto(details)
        : {
            id,
            name: setting?.name ?? id,
            path: [{ id, name: setting?.name ?? id }],
            childrenCount: 0,
            isLeaf: true,
          };
      return {
        ...dto,
        enabled: setting?.enabled ?? true,
        priority: setting?.priority ?? 0,
        minOffers: setting?.minOffers ?? null,
        maxOffers: setting?.maxOffers ?? null,
      };
    }),
  );
}

export async function getMercadoLivreCategoryBrowserData(
  categoryId?: string | null,
): Promise<MercadoLivreCategoryBrowserDto> {
  const connector = await connectorOrThrow();
  const currentCategory = categoryId
    ? await connector.getCategory(categoryId).catch(() => null)
    : null;
  if (categoryId && !currentCategory) {
    throw new MercadoLivreInteractiveServiceError(
      "CATEGORY_NOT_FOUND",
      "Categoria não encontrada.",
    );
  }
  const summaries = currentCategory
    ? await connector.getCategoryChildren(currentCategory.id)
    : await connector.getSiteCategories();
  const children = await Promise.all(
    summaries.map(async (summary) => {
      const details = await connector.getCategory(summary.id).catch(() => null);
      return details
        ? mercadoLivreCategoryDto(details)
        : {
            id: summary.id,
            name: summary.name,
            path: [{ id: summary.id, name: summary.name }],
            childrenCount: 1,
            isLeaf: false,
          };
    }),
  );
  return {
    currentCategory: currentCategory
      ? mercadoLivreCategoryDto(currentCategory)
      : null,
    children,
    configuredCategories: await configuredCategoryDtos(connector),
  };
}

type ConfigWrite = {
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
  multiCategoryEnabled: boolean;
  multiCategorySettings: Array<{
    categoryId: string;
    name: string | null;
    enabled: boolean;
    priority: number;
    minOffers: number | null;
    maxOffers: number | null;
    isLeaf: boolean;
  }>;
  multiCategoryMinOffersPerCategory: number;
  multiCategoryMaxOffersPerCategory: number;
  multiCategoryMaxTotalPerSession: number;
  multiCategorySelectionMode: "ROUND_ROBIN";
  multiCategoryAllowCategoryBackfill: boolean;
};

async function writeConfig(data: ConfigWrite) {
  const existing = await prisma.mercadoLivreDiscoveryConfig.findFirst({
    select: { id: true },
  });
  const payload = { ...data, categoryIds: unique(data.categoryIds) };
  if (existing) {
    await prisma.mercadoLivreDiscoveryConfig.update({
      where: { id: existing.id },
      data: payload,
    });
  } else {
    await prisma.mercadoLivreDiscoveryConfig.create({ data: payload });
  }
}

function optionalInteger(formData: FormData, name: string, categoryId: string) {
  const raw = formData.get(`${name}:${categoryId}`)?.toString().trim();
  if (!raw) return null;
  const value = Number(raw);
  return Number.isInteger(value) ? value : null;
}

export async function saveMercadoLivreDiscoveryConfig(formData: FormData) {
  const parsed = configSchema.safeParse({
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
    multiCategoryEnabled: formData.get("multiCategoryEnabled") === "on",
    multiCategoryMinOffersPerCategory:
      formData.get("multiCategoryMinOffersPerCategory") ?? 1,
    multiCategoryMaxOffersPerCategory:
      formData.get("multiCategoryMaxOffersPerCategory") ?? 2,
    multiCategoryMaxTotalPerSession:
      formData.get("multiCategoryMaxTotalPerSession") ?? 12,
    multiCategorySelectionMode:
      formData.get("multiCategorySelectionMode")?.toString() ?? "ROUND_ROBIN",
    multiCategoryAllowCategoryBackfill:
      formData.get("multiCategoryAllowCategoryBackfill") === "on",
  });
  if (!parsed.success) {
    throw new MercadoLivreInteractiveServiceError(
      "CONFIG_INVALID",
      "Revise os campos destacados da configuração.",
      Object.fromEntries(
        parsed.error.issues.map((issue) => [
          String(issue.path[0]),
          issue.message,
        ]),
      ),
    );
  }
  const categoryIds = stringList(parsed.data.categoryIds);
  const connector = categoryIds.length > 0 ? await connectorOrThrow() : null;
  const settings: ConfigWrite["multiCategorySettings"] = [];
  for (const id of categoryIds) {
    const category = await connector?.getCategory(id).catch(() => null);
    if (!category) {
      throw new MercadoLivreInteractiveServiceError(
        "CATEGORY_NOT_FOUND",
        `A categoria ${id} não foi encontrada.`,
        { categoryIds: `Revise a categoria ${id}.` },
      );
    }
    if (parsed.data.bestSellersEnabled && category.children.length > 0) {
      throw new MercadoLivreInteractiveServiceError(
        "CATEGORY_NOT_LEAF",
        `A categoria ${id} precisa ser uma categoria folha.`,
        { categoryIds: `A categoria ${id} não é folha.` },
      );
    }
    settings.push({
      categoryId: category.id,
      name: category.name,
      enabled: formData.get(`categoryEnabled:${id}`) === "on",
      priority: optionalInteger(formData, "categoryPriority", id) ?? 0,
      minOffers: optionalInteger(formData, "categoryMin", id),
      maxOffers: optionalInteger(formData, "categoryMax", id),
      isLeaf: category.children.length === 0,
    });
  }
  await writeConfig({
    ...parsed.data,
    categoryIds,
    minimumPrice: parsed.data.minimumPrice ?? null,
    maximumPrice: parsed.data.maximumPrice ?? null,
    minimumDiscountPercentage: parsed.data.minimumDiscountPercentage ?? null,
    multiCategorySettings: settings,
  });
  return getMercadoLivreDiscoveryConfigDto();
}

export async function addMercadoLivreDiscoveryCategory(categoryId: string) {
  const { connector, category } = await categoryOrThrow(categoryId);
  if (category.children.length > 0) {
    throw new MercadoLivreInteractiveServiceError(
      "CATEGORY_NOT_LEAF",
      "Selecione uma categoria folha.",
    );
  }
  const config = await prisma.mercadoLivreDiscoveryConfig.findFirst({
    orderBy: { updatedAt: "desc" },
  });
  const existingIds = Array.isArray(config?.categoryIds)
    ? config.categoryIds.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  const existingSettings = Array.isArray(config?.multiCategorySettings)
    ? (config.multiCategorySettings as ConfigWrite["multiCategorySettings"])
    : [];
  const alreadyConfigured = existingIds.includes(category.id);
  await writeConfig({
    enabled: config?.enabled ?? false,
    siteId: config?.siteId ?? getMercadoLivreConfig().siteId,
    categoryIds: [...existingIds, category.id],
    bestSellersEnabled: config?.bestSellersEnabled ?? true,
    minimumPrice: config?.minimumPrice ? Number(config.minimumPrice) : null,
    maximumPrice: config?.maximumPrice ? Number(config.maximumPrice) : null,
    minimumDiscountPercentage:
      config?.minimumDiscountPercentage == null
        ? null
        : Number(config.minimumDiscountPercentage),
    minimumScore: config?.minimumScore ?? 0,
    maxCandidatesPerCategory: config?.maxCandidatesPerCategory ?? 20,
    refreshIntervalMinutes: config?.refreshIntervalMinutes ?? 360,
    multiCategoryEnabled: config?.multiCategoryEnabled ?? false,
    multiCategorySettings: alreadyConfigured
      ? existingSettings
      : [
          ...existingSettings,
          {
            categoryId: category.id,
            name: category.name,
            enabled: true,
            priority: 0,
            minOffers: null,
            maxOffers: null,
            isLeaf: true,
          },
        ],
    multiCategoryMinOffersPerCategory:
      config?.multiCategoryMinOffersPerCategory ?? 1,
    multiCategoryMaxOffersPerCategory:
      config?.multiCategoryMaxOffersPerCategory ?? 2,
    multiCategoryMaxTotalPerSession:
      config?.multiCategoryMaxTotalPerSession ?? 12,
    multiCategorySelectionMode: "ROUND_ROBIN",
    multiCategoryAllowCategoryBackfill:
      config?.multiCategoryAllowCategoryBackfill ?? false,
  });
  const dto = mercadoLivreCategoryDto(category);
  return {
    category: {
      ...dto,
      enabled: true,
      priority: 0,
      minOffers: null,
      maxOffers: null,
    },
    alreadyConfigured,
    configuredCategories: await configuredCategoryDtos(connector),
  };
}

function highlightTypeCounts(highlights: MercadoLivreHighlightCandidate[]) {
  return highlights.reduce(
    (counts, candidate) => {
      if (candidate.type === "ITEM") counts.item += 1;
      else if (candidate.type === "PRODUCT") counts.product += 1;
      else if (candidate.type === "USER_PRODUCT") counts.userProduct += 1;
      else counts.unknown += 1;
      return counts;
    },
    { item: 0, product: 0, userProduct: 0, unknown: 0 },
  );
}

function emptyDiagnostics(): MercadoLivreProductResolutionDiagnostics {
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

function addDiagnostics(
  target: MercadoLivreProductResolutionDiagnostics,
  source?: MercadoLivreProductResolutionDiagnostics,
) {
  if (!source) return;
  for (const key of [
    "productDirectWinnerCount",
    "productParentCount",
    "productLeafCount",
    "productResolvedDirectly",
    "productResolvedViaChild",
    "productResolvedViaItems",
    "productResolvedViaCatalogPdp",
    "productCanonicalPdpCandidates",
    "productCanonicalPdpResolved",
    "productItemsFetched",
    "productItemsUsable",
    "productItemsSkipped",
    "productLeafWithoutWinner",
    "productParentWithoutResolvableChild",
  ] as const)
    target[key] += source[key];
  target.productDetailEnrichmentUnavailable ||=
    source.productDetailEnrichmentUnavailable;
  target.productPdpFallbackEligible ||= source.productPdpFallbackEligible;
}

export async function testMercadoLivreDiscoveryCategory(
  categoryId: string,
): Promise<MercadoLivreCategoryTestDto> {
  const { connector, category } = await categoryOrThrow(categoryId);
  let highlightsAvailable = false;
  let candidatesFound = 0;
  let highlightsReason = "";
  let counts = { item: 0, product: 0, userProduct: 0, unknown: 0 };
  let resolvedItemCandidates = 0;
  let unresolvedCandidates = 0;
  const reasons: Record<string, number> = {};
  const diagnostics = emptyDiagnostics();
  try {
    const highlights = await connector.getBestSellers(category.id);
    counts = highlightTypeCounts(highlights);
    highlightsAvailable = highlights.length > 0;
    candidatesFound = highlights.length;
    highlightsReason = highlightsAvailable
      ? "OK"
      : "NO_HIGHLIGHTS_FOR_CATEGORY";
    const resolver = new MercadoLivreHighlightResolver(connector);
    for (const highlight of highlights) {
      const result = await resolver.resolveCandidate(highlight);
      addDiagnostics(diagnostics, result.diagnostics);
      if (result.ok) resolvedItemCandidates += 1;
      else {
        unresolvedCandidates += 1;
        reasons[result.reason] = (reasons[result.reason] ?? 0) + 1;
      }
    }
  } catch (error) {
    highlightsReason =
      error instanceof MercadoLivreApiError && error.status === 404
        ? "NO_HIGHLIGHTS_FOR_CATEGORY"
        : "CATEGORY_API_ERROR";
  }
  return {
    category: mercadoLivreCategoryDto(category),
    highlightsAvailable,
    candidatesFound,
    highlightsReason,
    highlightItemCount: counts.item,
    highlightProductCount: counts.product,
    highlightUserProductCount: counts.userProduct,
    highlightUnknownTypeCount: counts.unknown,
    resolvedItemCandidates,
    unresolvedCandidates,
    resolutionReasons: Object.entries(reasons)
      .map(([reason, count]) => `${reason}:${count}`)
      .join(", "),
    productDirectWinnerCount: diagnostics.productDirectWinnerCount,
    productParentCount: diagnostics.productParentCount,
    productLeafCount: diagnostics.productLeafCount,
    productResolvedDirectly: diagnostics.productResolvedDirectly,
    productResolvedViaChild: diagnostics.productResolvedViaChild,
    productLeafWithoutWinner: diagnostics.productLeafWithoutWinner,
    productParentWithoutResolvableChild:
      diagnostics.productParentWithoutResolvableChild,
  };
}

export async function getMercadoLivreDiscoveryConfigDto(): Promise<MercadoLivreDiscoveryConfigDto> {
  const config = await prisma.mercadoLivreDiscoveryConfig.findFirst({
    orderBy: { updatedAt: "desc" },
  });
  const categoryIds = Array.isArray(config?.categoryIds)
    ? config.categoryIds.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  const connector = categoryIds.length > 0 ? await connectorOrThrow() : null;
  return {
    enabled: config?.enabled ?? false,
    siteId: config?.siteId ?? getMercadoLivreConfig().siteId,
    bestSellersEnabled: config?.bestSellersEnabled ?? true,
    minimumPrice: config?.minimumPrice?.toString() ?? "",
    maximumPrice: config?.maximumPrice?.toString() ?? "",
    minimumDiscountPercentage:
      config?.minimumDiscountPercentage?.toString() ?? "",
    minimumScore: config?.minimumScore ?? 0,
    maxCandidatesPerCategory: config?.maxCandidatesPerCategory ?? 20,
    refreshIntervalMinutes: config?.refreshIntervalMinutes ?? 360,
    multiCategoryEnabled: config?.multiCategoryEnabled ?? false,
    multiCategoryMinOffersPerCategory:
      config?.multiCategoryMinOffersPerCategory ?? 1,
    multiCategoryMaxOffersPerCategory:
      config?.multiCategoryMaxOffersPerCategory ?? 2,
    multiCategoryMaxTotalPerSession:
      config?.multiCategoryMaxTotalPerSession ?? 12,
    multiCategorySelectionMode: "ROUND_ROBIN",
    multiCategoryAllowCategoryBackfill:
      config?.multiCategoryAllowCategoryBackfill ?? false,
    categories: await configuredCategoryDtos(connector),
  };
}
