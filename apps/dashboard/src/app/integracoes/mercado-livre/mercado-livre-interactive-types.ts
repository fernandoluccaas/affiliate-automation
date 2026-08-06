export type MercadoLivreCategoryDto = {
  id: string;
  name: string;
  path: Array<{ id: string; name: string }>;
  childrenCount: number;
  isLeaf: boolean;
};

export type MercadoLivreConfiguredCategoryDto = MercadoLivreCategoryDto & {
  enabled: boolean;
  priority: number;
  minOffers: number | null;
  maxOffers: number | null;
};

export type MercadoLivreCategoryBrowserDto = {
  currentCategory: MercadoLivreCategoryDto | null;
  children: MercadoLivreCategoryDto[];
  configuredCategories: MercadoLivreConfiguredCategoryDto[];
};

export type MercadoLivreCategoryTestDto = {
  category: MercadoLivreCategoryDto;
  highlightsAvailable: boolean;
  candidatesFound: number;
  highlightsReason: string;
  highlightItemCount: number;
  highlightProductCount: number;
  highlightUserProductCount: number;
  highlightUnknownTypeCount: number;
  resolvedItemCandidates: number;
  unresolvedCandidates: number;
  resolutionReasons: string;
  productDirectWinnerCount: number;
  productParentCount: number;
  productLeafCount: number;
  productResolvedDirectly: number;
  productResolvedViaChild: number;
  productLeafWithoutWinner: number;
  productParentWithoutResolvableChild: number;
};

export type MercadoLivreDiscoveryConfigDto = {
  enabled: boolean;
  siteId: string;
  bestSellersEnabled: boolean;
  minimumPrice: string;
  maximumPrice: string;
  minimumDiscountPercentage: string;
  minimumScore: number;
  maxCandidatesPerCategory: number;
  refreshIntervalMinutes: number;
  multiCategoryEnabled: boolean;
  multiCategoryMinOffersPerCategory: number;
  multiCategoryMaxOffersPerCategory: number;
  multiCategoryMaxTotalPerSession: number;
  multiCategorySelectionMode: "ROUND_ROBIN";
  multiCategoryAllowCategoryBackfill: boolean;
  categories: MercadoLivreConfiguredCategoryDto[];
};

export type MercadoLivreAffiliateTagDto = {
  value: string;
  label: string;
  isDefault: boolean;
};

export type MercadoLivreAffiliateSessionActionDto = {
  code: string;
  status: string;
  affiliateTag: string | null;
  availableTags: MercadoLivreAffiliateTagDto[];
};

export type MercadoLivreAffiliateLinkTestDto = {
  affiliateUrl: string;
  provider: string;
  generatedAt: string;
};

export type MercadoLivrePendingLinksDto = {
  status: string;
  selected: number;
  processed: number;
  linksGenerated: number;
  updated: number;
  ineligible: number;
  pending: number;
  failed: number;
};

export type MercadoLivreProductDiagnosticDto = {
  productId: string;
  productFound: boolean;
  productStatus: string | null;
  productName: string | null;
  productPermalink: string | null;
  resolvedProductUrl: string | null;
  productUrlSource: string | null;
  productPictureCount: number;
  buyBoxWinnerPresent: boolean;
  buyBoxWinnerItemId: string | null;
  selectedItemId: string | null;
  selectedSellerId: string | null;
  selectedPrice: string | null;
  selectedFreeShipping: boolean | null;
  detailEnrichmentStatus: string;
  pdpFallbackEligible: boolean;
  resolutionEligible: boolean;
  rejectionReasons: string[];
  counts: Record<string, number>;
};

export type MercadoLivreCategorySearchProbeDto = {
  categoryId: string;
  categoryName: string;
  categoryPath: string;
  method: string;
  endpoint: string;
  categoryParameter: string;
  limit: number;
  diagnosis: string | null;
  authenticated: {
    attempted: boolean;
    ok: boolean;
    httpStatus: number | null;
    resultsFound: number;
    usableItems: number;
    errorCode: string | null;
  };
  public: {
    attempted: boolean;
    ok: boolean;
    httpStatus: number | null;
    resultsFound: number;
    usableItems: number;
    errorCode: string | null;
  };
};

export type MercadoLivreImportSummaryDto = {
  status: "SUCCEEDED" | "PARTIAL" | "FAILED" | "SKIPPED";
  candidatesFound: number;
  resolvedItemCandidates: number;
  newProducts: number;
  newOfferVersions: number;
  updatedOffers: number;
  readyToPublish: number;
  readyForAffiliateLink: number;
  affiliateLinksGenerated: number;
  affiliateLinksReused: number;
  errors: number;
};

export type MercadoLivreProductPdpAffiliateDiagnosticDto = {
  productId: string;
  endpointMode: string;
  affiliateHost: string;
  startsWithMeliLa: boolean;
  productUrlSource: string;
};

export type InteractiveActionResult<T> =
  | { ok: true; data: T; message: string }
  | {
      ok: false;
      errorCode: string;
      message: string;
      fieldErrors?: Record<string, string>;
    };
