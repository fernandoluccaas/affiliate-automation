import type { Readable } from "node:stream";

export type ShopeeAffiliateMode = "OFF" | "DATAFEED" | "OPEN_API" | "HYBRID";
export type ShopeeDatafeedSchema = "OFFICIAL_BR" | "BRAZIL";
export type ShopeeDatafeedSourceKind = "LOCAL_FILE" | "REMOTE_URL";
export type ShopeeLogicalCategory =
  | "CELULARES"
  | "CASA"
  | "MODA"
  | "RELOGIOS"
  | "AUTOMOTIVO"
  | "ELETRODOMESTICOS";

export type ShopeeAffiliateConfiguration = {
  enabled: boolean;
  requestedMode: string;
  mode: ShopeeAffiliateMode;
  state:
    | "DISABLED"
    | "READY_FOR_DATAFEED"
    | "READY_FOR_OPEN_API"
    | "READY_FOR_HYBRID"
    | "OPEN_API_NOT_CONFIGURED"
    | "WAITING_FOR_OFFICIAL_ACCESS"
    | "INVALID_CONFIGURATION";
  configurationValid: boolean;
  linksVerified: boolean;
  openApiConfigured: boolean;
  openApiReady: boolean;
  externalRequestsEnabled: boolean;
  operationalWritesEnabled: boolean;
  openApiTimeoutMs: number;
  openApiRateLimitPerHour: number;
  maxFileBytes: number;
  maxTrackedItems: number;
  recentSelectionWindowDays: number;
  maxPerShopPerSession: number;
  issues: string[];
};

export type ShopeeDatafeedSourceMetadata = {
  kind: "LOCAL_FILE";
  name: string;
  absolutePath: string;
  size: number;
  modifiedAt: string;
  fingerprint: string;
};

export interface DatafeedSource {
  readonly kind: ShopeeDatafeedSourceKind;
  open(input: {
    location: string;
    maxBytes: number;
    signal?: AbortSignal;
  }): Promise<{
    metadata: ShopeeDatafeedSourceMetadata;
    stream: Readable;
    release: () => Promise<void>;
  }>;
}

export type ShopeeOfficialBrRow = {
  shop_rating: string;
  itemid: string;
  sale_price: string;
  item_rating: string;
  global_category3: string;
  cb_option: string;
  discount_percentage: string;
  global_catid2: string;
  price: string;
  description: string;
  title: string;
  global_category1: string;
  image_link_3: string;
  global_catid1: string;
  global_catid3: string;
  like: string;
  condition: string;
  global_category2: string;
  model_ids: string;
  image_link: string;
  model_names: string;
  shop_name: string;
  product_link: string;
  "product_short link": string;
};

export type ShopeeBrazilRow = {
  image_link: string;
  itemid: string;
  price: string;
  global_category1: string;
  description: string;
  global_category2: string;
  global_item_attributes: string;
  item_rating: string;
  sale_price: string;
  global_catid2: string;
  discount_percentage: string;
  image_link_3: string;
  title: string;
  global_catid1: string;
  product_link: string;
  "product_short link": string;
};

export type ShopeeDatafeedProduct = {
  itemId: string;
  title: string;
  description: string | null;
  originalPrice: number | null;
  salePrice: number;
  discountPercentage: number | null;
  itemRating: number | null;
  shopRating: number | null;
  likeCount: number | null;
  condition: string | null;
  crossBorder: boolean | null;
  category1: string;
  category1Id: string | null;
  category2: string | null;
  category2Id: string | null;
  category3: string | null;
  category3Id: string | null;
  shopName: string | null;
  imageUrl: string;
  secondaryImageUrl: string | null;
  sourceProductUrl: string;
  candidateAffiliateUrl: string | null;
  verifiedAffiliateUrl: string | null;
  modelIds: string[] | null;
  modelNames: string[] | null;
  commissionAvailable: false;
  salesCountAvailable: false;
  source: ShopeeDatafeedSchema;
  sources: ShopeeDatafeedSchema[];
};

export type ShopeeDatafeedIssue = {
  source: string;
  line: number;
  code: string;
};

export type ShopeeDatafeedFileSummary = {
  name: string;
  schema: ShopeeDatafeedSchema | "UNKNOWN";
  size: number;
  modifiedAt: string;
  fingerprint: string;
  checksum: string;
  rowsProcessed: number;
  validRows: number;
  invalidRows: number;
  validProductUrls: number;
  candidateShortLinks: number;
  durationMs: number;
  approximatePeakHeapBytes: number;
};

export type ShopeeDatafeedInspectResult = {
  status: "INSPECTED";
  files: ShopeeDatafeedFileSummary[];
  rowsProcessed: number;
  validRows: number;
  invalidRows: number;
  duplicateItems: number;
  categories: Record<string, number>;
  validProductUrls: number;
  candidateShortLinks: number;
  issuesByCode: Record<string, number>;
  issueSamples: ShopeeDatafeedIssue[];
  durationMs: number;
  stateModified: false;
};

export type ShopeeCategoryRule = {
  id: ShopeeLogicalCategory;
  label: string;
  enabled: boolean;
  priority: number;
  minPerCategory: number;
  maxPerCategory: number;
  matches: Array<{ category1: string; category2?: string }>;
};

export type ShopeeDiscoveryFilters = {
  priceMin: number | null;
  priceMax: number | null;
  discountMin: number | null;
  itemRatingMin: number | null;
  shopRatingMin: number | null;
  allowedConditions: string[];
  crossBorderAllowed: boolean;
  forbiddenWords: string[];
  imageRequired: boolean;
  validProductUrlRequired: boolean;
};

export type ShopeeRankingWeights = {
  discount: number;
  itemRating: number;
  shopRating: number;
  likes: number;
  completeness: number;
};

export type ShopeeScoreBreakdown = {
  discountScore: number | null;
  itemRatingScore: number | null;
  shopRatingScore: number | null;
  likeScore: number | null;
  completenessScore: number;
  diversityPenalty: number;
};

export type ShopeeRankedCandidate = {
  itemId: string;
  title: string;
  category: ShopeeLogicalCategory;
  salePrice: number;
  originalPrice: number | null;
  discountPercentage: number | null;
  itemRating: number | null;
  shopRating: number | null;
  shopName?: string | null;
  imageUrl: string;
  sourceProductHost: string;
  candidateLinkHost: string | null;
  linkStatus: "VERIFIED" | "NOT_VERIFIED" | "MISSING";
  score: number;
  components: ShopeeScoreBreakdown;
  sources: ShopeeDatafeedSchema[];
};

export type ShopeePreviewCategorySummary = {
  id: ShopeeLogicalCategory;
  label: string;
  candidates: number;
  eligible: number;
  rejected: number;
  selected: number;
  quotaMet: boolean;
};

export type ShopeeDatafeedPreviewResult = {
  status: "PREVIEW_COMPLETED";
  files: ShopeeDatafeedFileSummary[];
  rowsProcessed: number;
  validRows: number;
  invalidRows: number;
  duplicateItems: number;
  mergeConflicts: number;
  conflictsByCode: Record<string, number>;
  rejectedByCode: Record<string, number>;
  categories: ShopeePreviewCategorySummary[];
  selected: ShopeeRankedCandidate[];
  linksVerified: boolean;
  publicationAllowed: false;
  databaseWrites: 0;
  publicationsCreated: 0;
  messagesSent: 0;
  durationMs: number;
  stateModified: false;
};

export interface ShopeeOfferProvider {
  readonly kind: "DATAFEED" | "OPEN_API";
  readonly available: boolean;
  stream(input: {
    files: string[];
    linksVerified: boolean;
    maxFileBytes: number;
    signal?: AbortSignal;
    onProduct: (product: ShopeeDatafeedProduct) => Promise<void> | void;
    onIssue?: (issue: ShopeeDatafeedIssue) => Promise<void> | void;
  }): Promise<ShopeeDatafeedFileSummary[]>;
}

export interface ShopeeAffiliateLinkProvider {
  readonly kind: "DATAFEED" | "OPEN_API";
  resolve(
    product: ShopeeDatafeedProduct,
    options?: { subIds?: string[] },
  ): Promise<
    | { status: "VERIFIED"; affiliateUrl: string; provider?: string }
    | { status: "UNVERIFIED"; candidateUrl: string | null; reason: string }
  >;
}

export interface ShopeeConversionProvider {
  readonly kind: "OPEN_API";
  readonly available: false;
  preflight(): Promise<{ ready: false; reason: string }>;
}
