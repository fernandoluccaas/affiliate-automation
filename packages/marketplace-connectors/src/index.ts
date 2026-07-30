import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { prisma, type MarketplaceAccount } from "@affiliate/database";
import { acquireLock } from "@affiliate/redis";
import type {
  Marketplace,
  ShippingStatus,
  StockStatus,
} from "@affiliate/shared";

const MERCADO_LIVRE_API_BASE_URL = "https://api.mercadolibre.com";
const MERCADO_LIVRE_AUTH_URL = "https://auth.mercadolivre.com.br/authorization";
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;

export type MarketplaceOfferCandidate = {
  marketplace: Marketplace;
  externalProductId: string;
  title: string;
  productUrl: string;
  currentPrice: number;
  description?: string | null;
  category?: string | null;
  imageUrl?: string | null;
  originalPrice?: number | null;
  discountPercentage?: number | null;
  couponCode?: string | null;
  couponExpiration?: Date | null;
  affiliateUrl?: string | null;
  commissionPercentage?: number | null;
  rating?: number | null;
  salesCount?: number | null;
  freeShipping?: boolean | null;
  availableQuantity?: number | null;
  sellerReputation?: number | null;
  shippingStatus?: ShippingStatus;
  stockStatus?: StockStatus;
  sellerId?: string | null;
  officialStoreId?: string | null;
  affiliateEligibility?: "ELIGIBLE" | "INELIGIBLE" | "UNKNOWN";
  affiliateLabel?: string | null;
  trackingStrategy?: "INTERNAL_REDIRECT" | "DIRECT_AFFILIATE_LINK";
  itemStatus?: string | null;
  itemCondition?: MercadoLivreItemCondition;
  channels?: string[];
  sourceHighlightId?: string;
  sourceHighlightType?: MercadoLivreHighlightCandidate["type"];
  resolvedProductId?: string;
  resolvedItemId?: string;
  candidateKind?: MercadoLivreResolvedCandidateKind;
  selectedCatalogItemId?: string;
  resolutionStrategy?: MercadoLivreResolutionStrategy;
  productUrlSource?: MercadoLivreCatalogProductUrlSource;
  priceSource?: MercadoLivrePriceSource;
  collectedAt?: Date;
};

export interface MarketplaceConnector {
  marketplace: Marketplace;
  healthCheck(): Promise<boolean>;
  getItem(id: string): Promise<MarketplaceOfferCandidate | null>;
  getItems(ids: string[]): Promise<MarketplaceOfferCandidate[]>;
  getItemsWithDiagnostics(ids: string[]): Promise<MercadoLivreItemsResult>;
  getPrice(itemId: string): Promise<MercadoLivrePrice>;
  getSiteCategories(): Promise<MercadoLivreCategoryChild[]>;
  getCategory(categoryId: string): Promise<MercadoLivreCategory | null>;
  getCategoryChildren(categoryId: string): Promise<MercadoLivreCategoryChild[]>;
  getBestSellers(categoryId: string): Promise<MercadoLivreHighlightCandidate[]>;
  getProduct(productId: string): Promise<MercadoLivreProduct | null>;
  getProductItems(
    productId: string,
  ): Promise<MercadoLivreProductItemsResolution>;
  getUserProduct(
    userProductId: string,
  ): Promise<MercadoLivreUserProduct | null>;
  getItemsByUserProduct(
    userId: string,
    userProductId: string,
  ): Promise<string[]>;
  probeCategorySearch(
    input: MercadoLivreCategorySearchProbeInput,
  ): Promise<MercadoLivreCategorySearchProbeResult>;
}

export type MercadoLivreEnv = {
  [key: string]: string | undefined;
  MERCADO_LIVRE_CLIENT_ID?: string;
  MERCADO_LIVRE_CLIENT_SECRET?: string;
  MERCADO_LIVRE_REDIRECT_URI?: string;
  MERCADO_LIVRE_SITE_ID?: string;
  MERCADOLIVRE_AFFILIATE_BASE_URL?: string;
  MERCADOLIVRE_AFFILIATE_REFERER?: string;
  MERCADOLIVRE_AFFILIATE_USER_AGENT?: string;
  MERCADOLIVRE_AFFILIATE_MAX_CONCURRENCY?: string;
  MERCADOLIVRE_AFFILIATE_TIMEOUT_MS?: string;
  MERCADOLIVRE_AFFILIATE_MAX_RETRIES?: string;
  CREDENTIALS_ENCRYPTION_KEY?: string;
  ENCRYPTION_KEY?: string;
  AUTH_SECRET?: string;
};

export type MercadoLivreConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  siteId: string;
};

export type MercadoLivreTokenResponse = {
  access_token: string;
  token_type?: string;
  expires_in: number;
  scope?: string;
  user_id: number | string;
  refresh_token?: string;
};

export type MercadoLivrePrice = {
  currentPrice: number | null;
  originalPrice: number | null;
};

export type MercadoLivrePriceSource =
  "PRICE_API" | "ITEM_FALLBACK" | "CATALOG_SUMMARY";

export type MercadoLivreItemFetchDiagnostics = {
  itemsFetched: number;
  priceApiFetched: number;
  priceFallbackUsed: number;
  priceUnavailable: number;
};

export type MercadoLivreItemsResult = {
  candidates: MarketplaceOfferCandidate[];
  diagnostics: MercadoLivreItemFetchDiagnostics;
};

export type MercadoLivreCategoryChild = {
  id: string;
  name: string;
};

export type MercadoLivreCategory = {
  id: string;
  name: string;
  pathFromRoot: MercadoLivreCategoryChild[];
  children: MercadoLivreCategoryChild[];
};

export type MercadoLivreCategorySearchProbeInput = {
  siteId: string;
  categoryId: string;
  limit: number;
  testPublicAttempt?: boolean;
  shortCircuitOnAuthenticatedSuccess?: boolean;
};

export type MercadoLivreCategorySearchProbeSample = {
  itemId: string;
  title?: string;
  price?: number;
  permalink?: string;
};

export type MercadoLivreApiErrorCause = {
  code?: string;
  message?: string;
  type?: string;
  department?: string;
  causeId?: string;
};

export type MercadoLivreApiErrorDetails = {
  httpStatus: number;
  error?: string;
  code?: string;
  message?: string;
  cause?: MercadoLivreApiErrorCause[];
  blocked_by?: string;
};

export type MercadoLivreForbiddenClassification =
  | "INVALID_SCOPES"
  | "ACCESS_DENIED"
  | "APPLICATION_RESTRICTED"
  | "TOKEN_FORBIDDEN"
  | "POLICY_DENIED"
  | "UNKNOWN_FORBIDDEN";

export type MercadoLivreCategorySearchProbeAttempt = {
  authenticationMode: "BEARER_TOKEN" | "PUBLIC";
  ok: boolean;
  httpStatus?: number;
  resultsFound: number;
  usableItemIds: string[];
  sample: MercadoLivreCategorySearchProbeSample[];
  errorCode?:
    "RATE_LIMITED" | "API_ERROR" | "INVALID_RESPONSE" | "NETWORK_OR_TIMEOUT";
  errorMessage?: string;
  apiError?: MercadoLivreApiErrorDetails;
  forbiddenClassification?: MercadoLivreForbiddenClassification;
};

export type MercadoLivreCategorySearchProbeResult = {
  method: "GET";
  endpoint: string;
  parameters: {
    category: string;
    limit: number;
  };
  categoryId: string;
  authenticatedAttempt: MercadoLivreCategorySearchProbeAttempt;
  publicAttempt?: MercadoLivreCategorySearchProbeAttempt;
  diagnosis?: MercadoLivreForbiddenClassification;
};

export type MercadoLivreHighlightType = "ITEM" | "PRODUCT" | "USER_PRODUCT";

export type MercadoLivreHighlightCandidate = {
  id: string;
  position: number;
  type: MercadoLivreHighlightType | "UNKNOWN";
  rawType: string | null;
  categoryId: string;
};

export type MercadoLivreBestSeller = MercadoLivreHighlightCandidate;

export type MercadoLivreProduct = {
  id: string;
  name: string | null;
  familyName: string | null;
  status: string | null;
  permalink: string | null;
  pictureUrls: string[];
  attributes: Array<{
    id: string;
    valueName: string | null;
  }>;
  domainId: string | null;
  parentId: string | null;
  childrenIds: string[];
  soldQuantity: number | null;
  buyBoxWinner: {
    itemId: string | null;
    price: number | null;
  } | null;
  buyBoxWinnerPriceRange: unknown;
  buyBoxWinnerItemId: string | null;
  buyBoxWinnerPrice: number | null;
};

export type MercadoLivreUserProduct = {
  id: string;
  userId: string | null;
};

export type MercadoLivreCatalogProductItemSummary = {
  itemId: string;
  siteId?: string;
  sellerId?: string;
  price?: number;
  originalPrice?: number;
  categoryId?: string;
  currencyId?: string;
  condition?: string;
  listingTypeId?: string;
  availableQuantity?: number;
  freeShipping?: boolean;
  officialStoreId?: string;
  sellerReputation?: number;
  summaryFieldsPresent: string[];
};

export type MercadoLivreProductItem = MercadoLivreCatalogProductItemSummary;

export type MercadoLivreItemCondition =
  "new" | "used" | "refurbished" | "unknown";

export type MercadoLivreProductItemRejectionReason =
  | "PRODUCT_ITEM_INVALID_ID"
  | "PRODUCT_ITEM_WRONG_SITE"
  | "PRODUCT_ITEM_SUMMARY_INVALID_PRICE"
  | "PRODUCT_ITEM_DETAIL_NOT_FOUND"
  | "PRODUCT_ITEM_DETAIL_HTTP_ERROR"
  | "PRODUCT_ITEM_INACTIVE"
  | "PRODUCT_ITEM_USED"
  | "PRODUCT_ITEM_REFURBISHED"
  | "PRODUCT_ITEM_NO_STOCK"
  | "PRODUCT_ITEM_NOT_MARKETPLACE"
  | "PRODUCT_ITEM_NO_PERMALINK"
  | "PRODUCT_ITEM_NO_PRICE"
  | "PRODUCT_ITEM_SCHEMA_MISMATCH";

export type MercadoLivreProductItemDiagnosticSample = {
  itemId: string | null;
  summaryFieldsPresent: string[];
  hydrationHttpStatus: number | null;
  hydratedStatus: string | null;
  hydratedCondition: MercadoLivreItemCondition;
  hydratedAvailableQuantity: number | null;
  hydratedChannels: string[];
  hasPermalink: boolean;
  hasPrice: boolean;
  rejectedReason: MercadoLivreProductItemRejectionReason | null;
};

export type MercadoLivreProductItemsDiagnostics = {
  productItemsHttpStatus: number;
  productItemsTotal: number;
  productItemsResultsCount: number;
  productItemsParsedCount: number;
  productItemsUniqueIds: number;
  productItemsHydrationRequested: number;
  productItemsHydrated: number;
  productItemsUsable: number;
  priceApiFetched: number;
  priceFallbackUsed: number;
  priceUnavailable: number;
  rejectionReasons: Partial<
    Record<MercadoLivreProductItemRejectionReason, number>
  >;
  samples: MercadoLivreProductItemDiagnosticSample[];
};

export type MercadoLivreProductItemsResolution = {
  summaries: MercadoLivreCatalogProductItemSummary[];
  candidates: MarketplaceOfferCandidate[];
  diagnostics: MercadoLivreProductItemsDiagnostics;
};

export type MercadoLivreHighlightSkipReason =
  | "UNSUPPORTED_HIGHLIGHT_TYPE"
  | "PRODUCT_NOT_FOUND"
  | "PRODUCT_PARENT_NO_RESOLVABLE_CHILD"
  | "PRODUCT_LEAF_NO_BUY_BOX_WINNER"
  | "PRODUCT_CHILD_NOT_FOUND"
  | "PRODUCT_CHILD_RESOLUTION_ERROR"
  | "PRODUCT_TREE_DEPTH_LIMIT"
  | "PRODUCT_TREE_SIZE_LIMIT"
  | "PRODUCT_ITEMS_EMPTY"
  | "PRODUCT_ITEMS_SCHEMA_MISMATCH"
  | "PRODUCT_ITEMS_HYDRATION_FAILED"
  | "PRODUCT_ITEMS_NO_USABLE_ITEM"
  | "PRODUCT_ITEMS_API_ERROR"
  | "PRODUCT_PDP_PERMALINK_MISSING"
  | "PRODUCT_CATALOG_URL_UNAVAILABLE"
  | "PRODUCT_PDP_FALLBACK_INELIGIBLE"
  | "USER_PRODUCT_NOT_FOUND"
  | "USER_PRODUCT_NO_USER"
  | "USER_PRODUCT_NO_ACTIVE_ITEM"
  | "CANDIDATE_RESOLUTION_ERROR";

export type MercadoLivreResolutionStrategy =
  | "ITEM_DIRECT"
  | "HIGHLIGHT_ITEM_DIRECT"
  | "PRODUCT_DIRECT_BUY_BOX"
  | "PRODUCT_CHILD_BUY_BOX"
  | "PRODUCT_ITEMS_FALLBACK"
  | "PRODUCT_CATALOG_PDP_FALLBACK"
  | "PRODUCT_CATALOG_CANONICAL_PDP"
  | "USER_PRODUCT_ACTIVE_ITEM";

export type MercadoLivreCatalogProductUrlSource =
  | "API_PERMALINK"
  | "CANONICAL_CATALOG_PDP";

export type MercadoLivreCatalogProductUrlResolution = {
  productUrl: string;
  source: MercadoLivreCatalogProductUrlSource;
};

export type MercadoLivreProductResolutionDiagnostics = {
  productDirectWinnerCount: number;
  productParentCount: number;
  productLeafCount: number;
  productResolvedDirectly: number;
  productResolvedViaChild: number;
  productResolvedViaItems: number;
  productResolvedViaCatalogPdp: number;
  productCanonicalPdpCandidates: number;
  productCanonicalPdpResolved: number;
  productDetailEnrichmentUnavailable: boolean;
  productPdpFallbackEligible: boolean;
  productItemsFetched: number;
  productItemsUsable: number;
  productItemsSkipped: number;
  productItemsHttpStatus?: number;
  productItemsTotal?: number;
  productItemsResultsCount?: number;
  productItemsParsedCount?: number;
  productItemsUniqueIds?: number;
  productItemsHydrationRequested?: number;
  productItemsHydrated?: number;
  productItemsPriceApiFetched?: number;
  productItemsPriceFallbackUsed?: number;
  productItemsPriceUnavailable?: number;
  productItemRejectionReasons?: Partial<
    Record<MercadoLivreProductItemRejectionReason, number>
  >;
  productItemSamples?: MercadoLivreProductItemDiagnosticSample[];
  productLeafWithoutWinner: number;
  productParentWithoutResolvableChild: number;
};

export type MercadoLivreResolvedCandidateKind =
  "ITEM" | "CATALOG_PRODUCT" | "USER_PRODUCT";

export type MercadoLivreResolvedCandidate = {
  kind: MercadoLivreResolvedCandidateKind;
  marketplaceExternalId: string;
  sourceHighlightId: string;
  sourceHighlightType: MercadoLivreHighlightCandidate["type"];
  resolvedProductId?: string;
  resolvedItemId?: string;
  selectedItemId?: string;
  selectedSellerId?: string;
  productUrlSource?: MercadoLivreCatalogProductUrlSource;
  offerCandidate?: MarketplaceOfferCandidate;
  resolutionStrategy: MercadoLivreResolutionStrategy;
  position: number;
  categoryId: string;
};

export type MercadoLivreResolvedHighlightCandidate =
  MercadoLivreResolvedCandidate;

export type MercadoLivreHighlightResolutionResult =
  | {
      ok: true;
      candidate: MercadoLivreResolvedHighlightCandidate;
      diagnostics?: MercadoLivreProductResolutionDiagnostics;
    }
  | {
      ok: false;
      reason: MercadoLivreHighlightSkipReason;
      candidate: MercadoLivreHighlightCandidate;
      diagnostics?: MercadoLivreProductResolutionDiagnostics;
    };

function normalizeHighlightType(
  value: unknown,
): MercadoLivreHighlightCandidate["type"] {
  const type = asString(value);

  if (type === "ITEM" || type === "PRODUCT" || type === "USER_PRODUCT") {
    return type;
  }

  return "UNKNOWN";
}

export type ApiFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
}>;

export class MercadoLivreApiError extends Error {
  readonly responseBody: MercadoLivreApiErrorDetails;

  constructor(
    message: string,
    readonly status: number,
    readonly details: MercadoLivreApiErrorDetails = { httpStatus: status },
  ) {
    super(message);
    this.name = "MercadoLivreApiError";
    this.responseBody = details;
  }
}

export class MercadoLivreInvalidResponseError extends Error {
  constructor(message = "Mercado Livre returned an invalid JSON response.") {
    super(message);
    this.name = "MercadoLivreInvalidResponseError";
  }
}

export class MercadoLivreOAuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "MercadoLivreOAuthError";
  }
}

export class MercadoLivreTokenRefreshInProgressError extends Error {
  readonly code = "TOKEN_REFRESH_IN_PROGRESS";

  constructor() {
    super("Mercado Livre token refresh is still in progress.");
    this.name = "MercadoLivreTokenRefreshInProgressError";
  }
}

export function getMercadoLivreConfig(
  env: MercadoLivreEnv = process.env,
): MercadoLivreConfig {
  return {
    clientId: env.MERCADO_LIVRE_CLIENT_ID?.trim() ?? "",
    clientSecret: env.MERCADO_LIVRE_CLIENT_SECRET?.trim() ?? "",
    redirectUri:
      env.MERCADO_LIVRE_REDIRECT_URI?.trim() ??
      "http://localhost:3000/api/integrations/mercadolivre/callback",
    siteId: env.MERCADO_LIVRE_SITE_ID?.trim() || "MLB",
  };
}

export function buildMercadoLivreAuthorizationUrl(
  state: string,
  env: MercadoLivreEnv = process.env,
) {
  const config = getMercadoLivreConfig(env);
  const url = new URL(MERCADO_LIVRE_AUTH_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

function encryptionSecrets(env: MercadoLivreEnv = process.env) {
  const secrets = [
    env.CREDENTIALS_ENCRYPTION_KEY,
    env.ENCRYPTION_KEY,
    env.AUTH_SECRET,
  ].filter(
    (secret, index, values): secret is string =>
      Boolean(secret && secret.length >= 16) &&
      values.indexOf(secret) === index,
  );

  if (secrets.length === 0) {
    throw new Error(
      "CREDENTIALS_ENCRYPTION_KEY, ENCRYPTION_KEY or AUTH_SECRET must be configured to encrypt credentials.",
    );
  }

  return secrets;
}

function encryptionKey(secret: string) {
  return createHash("sha256").update(secret).digest();
}

export function encryptSecret(
  value: string,
  env: MercadoLivreEnv = process.env,
) {
  const iv = randomBytes(12);
  const [secret] = encryptionSecrets(env);
  const cipher = createCipheriv(
    "aes-256-gcm",
    encryptionKey(secret as string),
    iv,
  );
  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${encrypted.toString("base64url")}`;
}

export function decryptSecret(
  value: string,
  env: MercadoLivreEnv = process.env,
) {
  const [version, ivValue, tagValue, encryptedValue] = value.split(":");

  if (version !== "v1" || !ivValue || !tagValue || !encryptedValue) {
    throw new Error("Invalid encrypted secret payload.");
  }

  for (const secret of encryptionSecrets(env)) {
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        encryptionKey(secret),
        Buffer.from(ivValue, "base64url"),
      );
      decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(encryptedValue, "base64url")),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      // Try legacy keys so configuring a dedicated credential key does not
      // invalidate OAuth credentials encrypted before the migration.
    }
  }

  throw new Error("Invalid encrypted secret payload.");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isRecord(
  value: Record<string, unknown> | null,
): value is Record<string, unknown> {
  return value !== null;
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asStringId(value: unknown) {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return null;
}

function asNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

const MAX_DIAGNOSTIC_TEXT_LENGTH = 500;

function sanitizeDiagnosticText(value: unknown, secrets: string[] = []) {
  const raw = asString(value);

  if (!raw) {
    return undefined;
  }

  let sanitized = raw
    .replace(
      /(\bauthorization\s*[:=]\s*)(?:Bearer\s+)?[^\s,;}]+/gi,
      "[REDACTED_CREDENTIAL]",
    )
    .replace(/\bBearer\s+[^\s,;}]+/gi, "Bearer [REDACTED]")
    .replace(
      /((?:access[\s_-]?token|refresh[\s_-]?token|client[\s_-]?secret)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,
      "$1[REDACTED]",
    );

  for (const secret of secrets) {
    if (secret.length >= 8) {
      sanitized = sanitized.split(secret).join("[REDACTED]");
    }
  }

  return sanitized.slice(0, MAX_DIAGNOSTIC_TEXT_LENGTH);
}

function sanitizeDiagnosticIdentifier(value: unknown, secrets: string[] = []) {
  const raw = asStringId(value);

  if (!raw) {
    return undefined;
  }

  let sanitized = raw;

  for (const secret of secrets) {
    if (secret.length >= 8) {
      sanitized = sanitized.split(secret).join("[REDACTED]");
    }
  }

  return sanitized.slice(0, MAX_DIAGNOSTIC_TEXT_LENGTH);
}

function sanitizeApiErrorCause(value: unknown, secrets: string[]) {
  const values = Array.isArray(value)
    ? value
    : value === undefined
      ? []
      : [value];
  const causes = values.slice(0, 10).flatMap((item) => {
    const record = asRecord(item);

    if (!record) {
      const message = sanitizeDiagnosticText(item, secrets);
      return message ? [{ message }] : [];
    }

    const cause: MercadoLivreApiErrorCause = {};
    const code = sanitizeDiagnosticIdentifier(record.code, secrets);
    const message = sanitizeDiagnosticText(record.message, secrets);
    const type = sanitizeDiagnosticIdentifier(record.type, secrets);
    const department = sanitizeDiagnosticIdentifier(record.department, secrets);
    const causeId = sanitizeDiagnosticIdentifier(
      record.cause_id ?? record.causeId,
      secrets,
    );

    if (code) cause.code = code;
    if (message) cause.message = message;
    if (type) cause.type = type;
    if (department) cause.department = department;
    if (causeId) cause.causeId = causeId;

    return Object.keys(cause).length > 0 ? [cause] : [];
  });

  return causes.length > 0 ? causes : undefined;
}

function sanitizeApiErrorDetails(
  body: unknown,
  httpStatus: number,
  secrets: string[],
): MercadoLivreApiErrorDetails {
  const record = asRecord(body);
  const details: MercadoLivreApiErrorDetails = { httpStatus };
  const error = sanitizeDiagnosticIdentifier(record?.error, secrets);
  const code = sanitizeDiagnosticIdentifier(record?.code, secrets);
  const message = sanitizeDiagnosticText(record?.message, secrets);
  const cause = sanitizeApiErrorCause(record?.cause, secrets);
  const blockedBy = sanitizeDiagnosticText(record?.blocked_by, secrets);

  if (error) details.error = error;
  if (code) details.code = code;
  if (message) details.message = message;
  if (cause) details.cause = cause;
  if (blockedBy) details.blocked_by = blockedBy;

  return details;
}

function responseErrorMessage(
  details: MercadoLivreApiErrorDetails,
  fallback: string,
) {
  const message = details.message ?? details.error;

  return message ? `${fallback}: ${message}` : fallback;
}

function oauthResponseErrorMessage(body: unknown, fallback: string) {
  const record = asRecord(body);
  const message = asString(record?.message) ?? asString(record?.error);

  return message ? `${fallback}: ${message}` : fallback;
}

function normalizedDiagnosticValues(details: MercadoLivreApiErrorDetails) {
  return [
    details.error,
    details.code,
    details.message,
    details.blocked_by,
    ...(details.cause ?? []).flatMap((cause) => [
      cause.code,
      cause.message,
      cause.type,
      cause.department,
    ]),
  ]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.toLowerCase());
}

export function classifyMercadoLivreForbidden(
  details: MercadoLivreApiErrorDetails,
): MercadoLivreForbiddenClassification | undefined {
  if (details.httpStatus !== 403) {
    return undefined;
  }

  const values = normalizedDiagnosticValues(details);
  const machineValues = [
    details.error,
    details.code,
    ...(details.cause ?? []).map((cause) => cause.code),
  ]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.toLowerCase().replace(/[\s-]+/g, "_"));
  const text = values.join(" ");

  if (
    machineValues.some((value) =>
      ["invalid_scope", "invalid_scopes", "insufficient_scope"].includes(value),
    ) ||
    /\b(?:invalid|insufficient|missing)\s+scopes?\b/.test(text)
  ) {
    return "INVALID_SCOPES";
  }

  if (
    machineValues.includes("application_restricted") ||
    /\b(?:application|app)\s+(?:is\s+)?restricted\b/.test(text)
  ) {
    return "APPLICATION_RESTRICTED";
  }

  if (
    machineValues.includes("token_forbidden") ||
    /\btoken\s+(?:is\s+)?(?:forbidden|not allowed)\b/.test(text)
  ) {
    return "TOKEN_FORBIDDEN";
  }

  if (
    machineValues.includes("policy_denied") ||
    /\b(?:policy\s+denied|blocked\s+by\s+(?:a\s+)?policy)\b/.test(text) ||
    /\bpolicy\b/.test(details.blocked_by?.toLowerCase() ?? "")
  ) {
    return "POLICY_DENIED";
  }

  if (
    machineValues.includes("access_denied") ||
    /\baccess[\s_-]+denied\b/.test(text)
  ) {
    return "ACCESS_DENIED";
  }

  return "UNKNOWN_FORBIDDEN";
}

function timeoutSignal(timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, clear: () => clearTimeout(timeout) };
}

export class MercadoLivreApiClient {
  constructor(
    private readonly options: {
      accessToken: string;
      baseUrl?: string;
      fetchFn?: ApiFetch;
      timeoutMs?: number;
      retries?: number;
    },
  ) {}

  async request(
    path: string,
    init: RequestInit = {},
    requestOptions: { authentication?: "BEARER_TOKEN" | "PUBLIC" } = {},
  ) {
    const result = await this.requestWithStatus(path, init, requestOptions);
    return result.body;
  }

  async requestWithStatus(
    path: string,
    init: RequestInit = {},
    requestOptions: { authentication?: "BEARER_TOKEN" | "PUBLIC" } = {},
  ): Promise<{ body: unknown; httpStatus: number }> {
    const url = `${this.options.baseUrl ?? MERCADO_LIVRE_API_BASE_URL}${path}`;
    const retries = this.options.retries ?? 2;
    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const timeout = timeoutSignal(this.options.timeoutMs ?? 10_000);

      try {
        const headers = new Headers(init.headers);

        if ((requestOptions.authentication ?? "BEARER_TOKEN") === "PUBLIC") {
          headers.delete("Authorization");
        } else {
          headers.set("Authorization", `Bearer ${this.options.accessToken}`);
        }

        const response = await (this.options.fetchFn ?? fetch)(url, {
          ...init,
          headers,
          signal: timeout.signal,
        });

        if (response.ok) {
          try {
            return {
              body: await response.json(),
              httpStatus: response.status,
            };
          } catch {
            throw new MercadoLivreInvalidResponseError();
          }
        }

        if (
          ![429, 500, 502, 503, 504].includes(response.status) ||
          attempt >= retries
        ) {
          let body: unknown;

          try {
            body = await response.json();
          } catch {
            body = undefined;
          }

          const fallback = `Mercado Livre API ${response.status}: ${response.statusText}`;
          const details = sanitizeApiErrorDetails(body, response.status, [
            this.options.accessToken,
          ]);
          throw new MercadoLivreApiError(
            responseErrorMessage(details, fallback),
            response.status,
            details,
          );
        }
      } catch (error) {
        lastError = error;

        if (
          error instanceof MercadoLivreApiError &&
          ![429, 500, 502, 503, 504].includes(error.status)
        ) {
          throw error;
        }

        if (attempt >= retries) {
          break;
        }
      } finally {
        timeout.clear();
      }

      await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
    }

    throw lastError instanceof Error
      ? lastError
      : new Error("Mercado Livre API request failed.");
  }
}

export class MercadoLivreOAuthClient {
  constructor(
    private readonly options: {
      fetchFn?: ApiFetch;
      env?: MercadoLivreEnv;
      timeoutMs?: number;
    } = {},
  ) {}

  async exchangeCode(code: string) {
    const config = getMercadoLivreConfig(this.options.env);
    return this.tokenRequest({
      grant_type: "authorization_code",
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: config.redirectUri,
    });
  }

  async refresh(refreshToken: string) {
    const config = getMercadoLivreConfig(this.options.env);
    return this.tokenRequest({
      grant_type: "refresh_token",
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: refreshToken,
    });
  }

  private async tokenRequest(payload: Record<string, string>) {
    const timeout = timeoutSignal(this.options.timeoutMs ?? 10_000);

    try {
      const response = await (this.options.fetchFn ?? fetch)(
        `${MERCADO_LIVRE_API_BASE_URL}/oauth/token`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
          },
          body: new URLSearchParams(payload).toString(),
          signal: timeout.signal,
        },
      );

      if (!response.ok) {
        let body: unknown;

        try {
          body = await response.json();
        } catch {
          body = undefined;
        }

        const record = asRecord(body);
        const code = asString(record?.error) ?? undefined;
        throw new MercadoLivreOAuthError(
          oauthResponseErrorMessage(
            body,
            `Mercado Livre OAuth ${response.status}: ${response.statusText}`,
          ),
          response.status,
          code,
        );
      }

      let json: unknown;

      try {
        json = await response.json();
      } catch {
        throw new MercadoLivreInvalidResponseError(
          "Mercado Livre OAuth returned invalid JSON.",
        );
      }

      const body = asRecord(json);

      if (
        !body ||
        typeof body.access_token !== "string" ||
        typeof body.expires_in !== "number" ||
        (typeof body.user_id !== "number" && typeof body.user_id !== "string")
      ) {
        throw new Error(
          "Mercado Livre OAuth returned an invalid token response.",
        );
      }

      return body as MercadoLivreTokenResponse;
    } finally {
      timeout.clear();
    }
  }
}

export async function saveMercadoLivreTokenResponse(
  token: MercadoLivreTokenResponse,
  env: MercadoLivreEnv = process.env,
) {
  const config = getMercadoLivreConfig(env);
  const scopes = token.scope?.split(/\s+/).filter(Boolean) ?? [];
  const expiresAt = new Date(Date.now() + token.expires_in * 1000);
  const refreshTokenEncrypted = token.refresh_token
    ? encryptSecret(token.refresh_token, env)
    : undefined;

  return prisma.marketplaceAccount.upsert({
    where: { id: "mercado-livre-default" },
    update: {
      marketplace: "MERCADO_LIVRE",
      name: "Mercado Livre",
      externalUserId: String(token.user_id),
      accessTokenEncrypted: encryptSecret(token.access_token, env),
      ...(refreshTokenEncrypted ? { refreshTokenEncrypted } : {}),
      expiresAt,
      scopes,
      status: "CONNECTED",
      siteId: config.siteId,
      enabled: true,
      lastRefreshAt: new Date(),
      lastErrorAt: null,
      lastError: null,
    },
    create: {
      id: "mercado-livre-default",
      marketplace: "MERCADO_LIVRE",
      name: "Mercado Livre",
      encryptedCredentials: "",
      externalUserId: String(token.user_id),
      accessTokenEncrypted: encryptSecret(token.access_token, env),
      refreshTokenEncrypted: refreshTokenEncrypted ?? null,
      expiresAt,
      scopes,
      status: "CONNECTED",
      siteId: config.siteId,
      enabled: true,
      lastRefreshAt: new Date(),
    },
  });
}

export class MercadoLivreTokenService {
  constructor(
    private readonly options: {
      oauth?: MercadoLivreOAuthClient;
      env?: MercadoLivreEnv;
      acquireLock?: typeof acquireLock;
      sleep?: (durationMs: number) => Promise<void>;
      refreshWaitTimeoutMs?: number;
      refreshPollIntervalMs?: number;
      now?: () => number;
    } = {},
  ) {}

  async getValidAccessToken() {
    const now = this.options.now?.() ?? Date.now();
    const account = await prisma.marketplaceAccount.findFirst({
      where: { marketplace: "MERCADO_LIVRE", enabled: true },
      orderBy: { updatedAt: "desc" },
    });

    if (!account?.accessTokenEncrypted || !account.expiresAt) {
      throw new Error("Mercado Livre account is not connected.");
    }

    if (account.expiresAt.getTime() - now > TOKEN_REFRESH_SKEW_MS) {
      return decryptSecret(account.accessTokenEncrypted, this.options.env);
    }

    const lock = await (this.options.acquireLock ?? acquireLock)(
      `mercado-livre:token-refresh:${account.id}`,
      60_000,
    );

    if (!lock.acquired) {
      return this.waitForConcurrentRefresh(account);
    }

    try {
      return await this.refreshAccount(account);
    } finally {
      await lock.release();
    }
  }

  private async waitForConcurrentRefresh(account: MarketplaceAccount) {
    const timeoutMs = this.options.refreshWaitTimeoutMs ?? 5_000;
    const pollIntervalMs = this.options.refreshPollIntervalMs ?? 100;
    const sleep =
      this.options.sleep ??
      ((durationMs: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, durationMs)));
    const startedAt = this.options.now?.() ?? Date.now();

    while ((this.options.now?.() ?? Date.now()) - startedAt < timeoutMs) {
      await sleep(pollIntervalMs);
      const fresh = await prisma.marketplaceAccount.findUnique({
        where: { id: account.id },
      });

      if (fresh?.status === "REAUTH_REQUIRED") {
        throw new Error("Mercado Livre account requires reauthentication.");
      }

      if (fresh?.accessTokenEncrypted && fresh.expiresAt) {
        const tokenChanged =
          fresh.accessTokenEncrypted !== account.accessTokenEncrypted ||
          fresh.expiresAt.getTime() !== account.expiresAt?.getTime();

        if (
          tokenChanged &&
          fresh.expiresAt.getTime() - (this.options.now?.() ?? Date.now()) >
            TOKEN_REFRESH_SKEW_MS
        ) {
          return decryptSecret(fresh.accessTokenEncrypted, this.options.env);
        }
      }
    }

    throw new MercadoLivreTokenRefreshInProgressError();
  }

  private async refreshAccount(account: MarketplaceAccount) {
    if (!account.refreshTokenEncrypted) {
      await markMercadoLivreAccountError(
        account.id,
        "Refresh token is missing.",
        "REAUTH_REQUIRED",
      );
      throw new Error("Mercado Livre refresh token is missing.");
    }

    try {
      const oauth =
        this.options.oauth ??
        new MercadoLivreOAuthClient(
          this.options.env ? { env: this.options.env } : {},
        );
      const response = await oauth.refresh(
        decryptSecret(account.refreshTokenEncrypted, this.options.env),
      );

      if (!response.refresh_token) {
        throw new Error(
          "Mercado Livre did not return a rotated refresh token.",
        );
      }

      await saveMercadoLivreTokenResponse(response, this.options.env);
      return response.access_token;
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Mercado Livre refresh failed.";

      if (isMercadoLivreReauthenticationError(error)) {
        await markMercadoLivreAccountError(
          account.id,
          message,
          "REAUTH_REQUIRED",
        );
      } else {
        await recordMercadoLivreOperationalError(
          account.id,
          message,
          "MELI_REFRESH_FAILED",
        );
      }

      throw error;
    }
  }
}

export function isMercadoLivreReauthenticationError(error: unknown) {
  return (
    error instanceof MercadoLivreOAuthError &&
    (error.code === "invalid_grant" ||
      error.status === 401 ||
      error.status === 403)
  );
}

export async function recordMercadoLivreOperationalError(
  accountId: string,
  message: string,
  alertCode = "MELI_OPERATIONAL_FAILURE",
) {
  await prisma.$transaction([
    prisma.marketplaceAccount.update({
      where: { id: accountId },
      data: {
        lastErrorAt: new Date(),
        lastError: message,
      },
    }),
    prisma.systemAlert.create({
      data: {
        severity: "ERROR",
        source: "mercado-livre.operation",
        message: alertCode,
        metadata: { marketplaceAccountId: accountId, error: message },
      },
    }),
  ]);
}

export async function markMercadoLivreAccountError(
  accountId: string,
  message: string,
  status: "REAUTH_REQUIRED" = "REAUTH_REQUIRED",
) {
  await prisma.$transaction([
    prisma.marketplaceAccount.update({
      where: { id: accountId },
      data: {
        status,
        lastErrorAt: new Date(),
        lastError: message,
      },
    }),
    prisma.systemAlert.create({
      data: {
        severity: "ERROR",
        source: "mercado-livre.token",
        message: "MELI_AUTH_EXPIRED",
        metadata: { marketplaceAccountId: accountId, error: message },
      },
    }),
  ]);
}

export class MercadoLivrePriceService {
  constructor(private readonly client: MercadoLivreApiClient) {}

  async getPrice(itemId: string): Promise<MercadoLivrePrice> {
    const body = asRecord(
      await this.client.request(`/items/${encodeURIComponent(itemId)}/prices`),
    );
    const prices = asArray(body?.prices);
    const active =
      prices.find((price) => asRecord(price)?.type === "standard") ?? prices[0];
    const activeRecord = asRecord(active);
    const amount = asNumber(
      activeRecord?.amount ?? activeRecord?.regular_amount,
    );
    const metadata = asRecord(activeRecord?.metadata);
    const original = asNumber(
      metadata?.campaign_discount_original_price ??
        activeRecord?.regular_amount,
    );

    return {
      currentPrice: amount,
      originalPrice:
        original !== null && amount !== null && original > amount
          ? original
          : null,
    };
  }
}

export class MercadoLivreAffiliateEligibilityService {
  evaluate(item: Record<string, unknown>) {
    if (asString(item.condition) && asString(item.condition) !== "new") {
      return "INELIGIBLE" as const;
    }

    return "UNKNOWN" as const;
  }
}

function normalizeStock(item: Record<string, unknown>): StockStatus {
  const status = asString(item.status);

  if (status && status !== "active") {
    return "OUT_OF_STOCK";
  }

  const quantity = asNumber(item.available_quantity);

  if (quantity === null) {
    return "UNKNOWN";
  }

  return quantity > 0 ? "IN_STOCK" : "OUT_OF_STOCK";
}

function normalizeShipping(item: Record<string, unknown>): ShippingStatus {
  const shipping = asRecord(item.shipping);

  if (typeof shipping?.free_shipping === "boolean") {
    return shipping.free_shipping ? "FREE" : "NOT_FREE";
  }

  return "UNKNOWN";
}

function normalizeItemUrl(item: Record<string, unknown>) {
  return asString(item.permalink) ?? "";
}

function isMercadoLivreItemId(value: string | null) {
  return Boolean(value && /^MLB\d+$/i.test(value));
}

function normalizedCondition(value: unknown): MercadoLivreItemCondition {
  const condition = asString(value)?.toLowerCase();

  if (condition === "new") return "new";
  if (condition === "used") return "used";
  if (condition === "refurbished") return "refurbished";
  return "unknown";
}

export function resolveMercadoLivreItemCondition(
  item: Record<string, unknown>,
): MercadoLivreItemCondition {
  const direct = normalizedCondition(item.item_condition);

  if (direct !== "unknown") {
    return direct;
  }

  const legacy = normalizedCondition(item.condition);

  if (legacy !== "unknown") {
    return legacy;
  }

  const attribute = asArray(item.attributes)
    .map(asRecord)
    .filter(isRecord)
    .find(
      (entry) =>
        asString(entry.id)?.toUpperCase() === "ITEM_CONDITION" ||
        asString(entry.attribute_group_id)?.toUpperCase() === "ITEM_CONDITION",
    );
  const attributeValue = asRecord(attribute?.value_struct);

  return normalizedCondition(
    attribute?.value_name ??
      attribute?.value_id ??
      attribute?.value ??
      attributeValue?.name,
  );
}

function isHttpsUrl(value: string) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export function isSafeMercadoLivreProductPermalink(value: string | null) {
  if (!value) return false;

  try {
    const url = new URL(value);
    const allowedDomains = ["mercadolivre.com.br", "mercadolibre.com"];

    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      allowedDomains.some(
        (domain) =>
          url.hostname === domain || url.hostname.endsWith(`.${domain}`),
      )
    );
  } catch {
    return false;
  }
}

export function resolveMercadoLivreCatalogProductUrl(input: {
  productId: string;
  productPermalink: string | null;
  productStatus: string | null;
}): MercadoLivreCatalogProductUrlResolution | null {
  if (isSafeMercadoLivreProductPermalink(input.productPermalink)) {
    return {
      productUrl: input.productPermalink as string,
      source: "API_PERMALINK",
    };
  }

  const normalizedStatus = input.productStatus?.trim().toLowerCase() ?? null;
  const explicitlyInactiveStatuses = new Set([
    "inactive",
    "paused",
    "closed",
    "deleted",
    "archived",
    "disabled",
  ]);

  if (
    !/^MLB\d+$/.test(input.productId) ||
    (normalizedStatus !== null &&
      explicitlyInactiveStatuses.has(normalizedStatus))
  ) {
    return null;
  }

  return {
    productUrl: `https://www.mercadolivre.com.br/p/${input.productId}`,
    source: "CANONICAL_CATALOG_PDP",
  };
}

function summaryFieldsPresent(item: Record<string, unknown>) {
  const fields = [
    "item_id",
    "id",
    "site_id",
    "seller_id",
    "price",
    "original_price",
    "category_id",
    "currency_id",
    "condition",
    "item_condition",
    "listing_type_id",
    "available_quantity",
    "official_store_id",
    "shipping",
  ];
  return fields.filter((field) => item[field] !== undefined);
}

export function parseMercadoLivreCatalogProductItemSummary(
  value: unknown,
): MercadoLivreCatalogProductItemSummary | null {
  const item = asRecord(value);

  if (!item) {
    return null;
  }

  const preferredId = asStringId(item.item_id);
  const fallbackId = asStringId(item.id);
  const itemId = isMercadoLivreItemId(preferredId)
    ? preferredId
    : isMercadoLivreItemId(fallbackId)
      ? fallbackId
      : null;

  if (!itemId) {
    return null;
  }

  const shipping = asRecord(item.shipping);
  const seller = asRecord(item.seller);
  const reputation = asRecord(
    item.seller_reputation ?? seller?.seller_reputation,
  );
  const transactions = asRecord(reputation?.transactions);
  const completed = asNumber(transactions?.completed);
  const total = asNumber(transactions?.total);
  const sellerReputation =
    completed !== null && total !== null && total > 0
      ? completed / total
      : asNumber(item.seller_reputation_score ?? seller?.reputation);
  const result: MercadoLivreCatalogProductItemSummary = {
    itemId,
    summaryFieldsPresent: summaryFieldsPresent(item),
  };
  const siteId = asString(item.site_id);
  const sellerId = asStringId(item.seller_id);
  const price = asNumber(item.price);
  const originalPrice = asNumber(item.original_price);
  const categoryId = asString(item.category_id);
  const currencyId = asString(item.currency_id);
  const condition = asString(item.item_condition ?? item.condition);
  const listingTypeId = asString(item.listing_type_id);
  const availableQuantity = asNumber(item.available_quantity);
  const officialStoreId = asStringId(item.official_store_id);

  if (siteId) result.siteId = siteId;
  if (sellerId) result.sellerId = sellerId;
  if (price !== null) result.price = price;
  if (originalPrice !== null) result.originalPrice = originalPrice;
  if (categoryId) result.categoryId = categoryId;
  if (currencyId) result.currencyId = currencyId;
  if (condition) result.condition = condition;
  if (listingTypeId) result.listingTypeId = listingTypeId;
  if (availableQuantity !== null) {
    result.availableQuantity = availableQuantity;
  }
  if (typeof shipping?.free_shipping === "boolean") {
    result.freeShipping = shipping.free_shipping;
  }
  if (officialStoreId) result.officialStoreId = officialStoreId;
  if (sellerReputation !== null) result.sellerReputation = sellerReputation;
  return result;
}

export function selectBestMercadoLivreCatalogProductSummary(
  summaries: readonly MercadoLivreCatalogProductItemSummary[],
) {
  const valid = summaries.filter((summary) => {
    const condition = normalizedCondition(summary.condition);

    return (
      isMercadoLivreItemId(summary.itemId) &&
      (!summary.siteId || summary.siteId.toUpperCase() === "MLB") &&
      condition !== "used" &&
      condition !== "refurbished" &&
      summary.price !== undefined &&
      summary.price > 0
    );
  });

  const [selected] = [...valid].sort((left, right) => {
    const condition =
      Number(normalizedCondition(right.condition) === "new") -
      Number(normalizedCondition(left.condition) === "new");
    if (condition !== 0) return condition;

    const freeShipping =
      Number(right.freeShipping === true) - Number(left.freeShipping === true);
    if (freeShipping !== 0) return freeShipping;

    const officialStore =
      Number(Boolean(right.officialStoreId)) -
      Number(Boolean(left.officialStoreId));
    if (officialStore !== 0) return officialStore;

    const leftReputation = left.sellerReputation ?? null;
    const rightReputation = right.sellerReputation ?? null;

    if (
      leftReputation !== null &&
      rightReputation !== null &&
      leftReputation !== rightReputation
    ) {
      return rightReputation - leftReputation;
    }
    if (leftReputation !== null && rightReputation === null) return -1;
    if (leftReputation === null && rightReputation !== null) return 1;

    if (left.price !== right.price) {
      return (left.price as number) - (right.price as number);
    }

    const leftQuantity = left.availableQuantity ?? null;
    const rightQuantity = right.availableQuantity ?? null;

    if (
      leftQuantity !== null &&
      rightQuantity !== null &&
      leftQuantity !== rightQuantity
    ) {
      return rightQuantity - leftQuantity;
    }
    if (leftQuantity !== null && rightQuantity === null) return -1;
    if (leftQuantity === null && rightQuantity !== null) return 1;
    return left.itemId.localeCompare(right.itemId);
  });

  return selected ?? null;
}

export class MercadoLivreConnector implements MarketplaceConnector {
  readonly marketplace = "MERCADO_LIVRE" as const;
  private readonly priceService: MercadoLivrePriceService;
  private readonly eligibility = new MercadoLivreAffiliateEligibilityService();

  constructor(
    private readonly options: {
      client: MercadoLivreApiClient;
      siteId?: string;
      priceService?: MercadoLivrePriceService;
    },
  ) {
    this.priceService =
      options.priceService ?? new MercadoLivrePriceService(options.client);
  }

  async healthCheck() {
    try {
      await this.options.client.request(
        `/sites/${this.options.siteId ?? "MLB"}`,
      );
      return true;
    } catch {
      return false;
    }
  }

  async getItem(id: string) {
    const items = await this.getItems([id]);
    return items[0] ?? null;
  }

  async getItems(ids: string[]) {
    const result = await this.getItemsWithDiagnostics(ids);
    return result.candidates;
  }

  async getItemsWithDiagnostics(
    ids: string[],
  ): Promise<MercadoLivreItemsResult> {
    const diagnostics: MercadoLivreItemFetchDiagnostics = {
      itemsFetched: 0,
      priceApiFetched: 0,
      priceFallbackUsed: 0,
      priceUnavailable: 0,
    };

    if (ids.length === 0) {
      return { candidates: [], diagnostics };
    }

    const chunks: string[][] = [];

    for (let index = 0; index < ids.length; index += 20) {
      chunks.push(ids.slice(index, index + 20));
    }

    const candidates: MarketplaceOfferCandidate[] = [];

    for (const chunk of chunks) {
      const body = await this.options.client.request(
        `/items?ids=${chunk.map(encodeURIComponent).join(",")}`,
      );
      const rows = Array.isArray(body) ? body : [];

      for (const row of rows) {
        const record = asRecord(row);
        const item = asRecord(record?.body ?? row);

        if (!item) {
          continue;
        }

        diagnostics.itemsFetched += 1;
        const normalized = await this.normalizeItem(item);

        if (normalized.priceSource === "PRICE_API") {
          diagnostics.priceApiFetched += 1;
        } else if (normalized.priceSource === "ITEM_FALLBACK") {
          diagnostics.priceFallbackUsed += 1;
        } else if (normalized.priceUnavailable) {
          diagnostics.priceUnavailable += 1;
        }

        if (normalized.candidate) {
          candidates.push(normalized.candidate);
        }
      }
    }

    return { candidates, diagnostics };
  }

  async getPrice(itemId: string) {
    return this.priceService.getPrice(itemId);
  }

  async getSiteCategories() {
    const siteId = this.options.siteId ?? "MLB";
    const body = await this.options.client.request(
      `/sites/${encodeURIComponent(siteId)}/categories`,
    );
    return asArray(body)
      .map(asRecord)
      .filter(isRecord)
      .map((item) => ({
        id: asString(item.id) ?? "",
        name: asString(item.name) ?? "",
      }))
      .filter((item) => item.id);
  }

  async getCategory(categoryId: string) {
    const category = asRecord(
      await this.options.client.request(
        `/categories/${encodeURIComponent(categoryId)}`,
      ),
    );

    if (!category) {
      return null;
    }

    return {
      id: asString(category.id) ?? categoryId,
      name: asString(category.name) ?? categoryId,
      pathFromRoot: asArray(category.path_from_root)
        .map(asRecord)
        .filter(isRecord)
        .map((item) => ({
          id: asString(item.id) ?? "",
          name: asString(item.name) ?? "",
        }))
        .filter((item) => item.id),
      children: asArray(category.children_categories)
        .map(asRecord)
        .filter(isRecord)
        .map((item) => ({
          id: asString(item.id) ?? "",
          name: asString(item.name) ?? "",
        }))
        .filter((item) => item.id),
    };
  }

  async getCategoryChildren(categoryId: string) {
    const category = await this.getCategory(categoryId);
    return category?.children ?? [];
  }

  async getProduct(productId: string) {
    const product = asRecord(
      await this.options.client.request(
        `/products/${encodeURIComponent(productId)}`,
      ),
    );

    if (!product) {
      return null;
    }

    const buyBoxWinner = asRecord(product.buy_box_winner);
    const childrenIds = asArray(product.children_ids)
      .map(asStringId)
      .filter((item): item is string => Boolean(item));
    const pictureUrls = asArray(product.pictures)
      .map(asRecord)
      .filter(isRecord)
      .map((picture) => asString(picture.secure_url ?? picture.url))
      .filter((pictureUrl): pictureUrl is string =>
        Boolean(pictureUrl && isHttpsUrl(pictureUrl)),
      );
    const attributes = asArray(product.attributes)
      .map(asRecord)
      .filter(isRecord)
      .map((attribute) => ({
        id: asString(attribute.id) ?? "",
        valueName: asString(
          attribute.value_name ?? attribute.value_id ?? attribute.value,
        ),
      }))
      .filter((attribute) => Boolean(attribute.id));
    const buyBoxWinnerItemId = asStringId(buyBoxWinner?.item_id);
    const parsedProduct = {
      id: asString(product.id) ?? productId,
      name: asString(product.name),
      familyName: asString(product.family_name),
      status: asString(product.status),
      permalink: asString(product.permalink),
      pictureUrls,
      attributes,
      domainId: asString(product.domain_id),
      parentId: asStringId(product.parent_id),
      childrenIds,
      soldQuantity: asNumber(product.sold_quantity),
      buyBoxWinner: buyBoxWinner
        ? {
            itemId: buyBoxWinnerItemId,
            price: asNumber(buyBoxWinner.price),
          }
        : null,
      buyBoxWinnerPriceRange: product.buy_box_winner_price_range,
      buyBoxWinnerItemId,
      buyBoxWinnerPrice: asNumber(buyBoxWinner?.price),
    };

    return parsedProduct;
  }

  async getProductItems(productId: string) {
    const productItemsResponse = await this.options.client.requestWithStatus(
      `/products/${encodeURIComponent(productId)}/items?limit=100&offset=0`,
    );
    const body = asRecord(productItemsResponse.body);
    const results = asArray(body?.results);
    const paging = asRecord(body?.paging);
    const diagnostics: MercadoLivreProductItemsDiagnostics = {
      productItemsHttpStatus: productItemsResponse.httpStatus,
      productItemsTotal: asNumber(paging?.total) ?? results.length,
      productItemsResultsCount: results.length,
      productItemsParsedCount: 0,
      productItemsUniqueIds: 0,
      productItemsHydrationRequested: 0,
      productItemsHydrated: 0,
      productItemsUsable: 0,
      priceApiFetched: 0,
      priceFallbackUsed: 0,
      priceUnavailable: 0,
      rejectionReasons: {},
      samples: [],
    };
    const reject = (
      reason: MercadoLivreProductItemRejectionReason,
      input: {
        itemId?: string | null;
        summaryFieldsPresent?: string[];
        hydrationHttpStatus?: number | null;
        hydratedStatus?: string | null;
        hydratedCondition?: MercadoLivreItemCondition;
        hydratedAvailableQuantity?: number | null;
        hydratedChannels?: string[];
        hasPermalink?: boolean;
        hasPrice?: boolean;
      } = {},
    ) => {
      diagnostics.rejectionReasons[reason] =
        (diagnostics.rejectionReasons[reason] ?? 0) + 1;

      if (diagnostics.samples.length < 3) {
        diagnostics.samples.push({
          itemId: input.itemId ?? null,
          summaryFieldsPresent: input.summaryFieldsPresent ?? [],
          hydrationHttpStatus: input.hydrationHttpStatus ?? null,
          hydratedStatus: input.hydratedStatus ?? null,
          hydratedCondition: input.hydratedCondition ?? "unknown",
          hydratedAvailableQuantity: input.hydratedAvailableQuantity ?? null,
          hydratedChannels: input.hydratedChannels ?? [],
          hasPermalink: input.hasPermalink ?? false,
          hasPrice: input.hasPrice ?? false,
          rejectedReason: reason,
        });
      }
    };
    const parsedSummaries: MercadoLivreCatalogProductItemSummary[] = [];

    for (const result of results) {
      const summary = parseMercadoLivreCatalogProductItemSummary(result);

      if (!summary) {
        reject("PRODUCT_ITEM_INVALID_ID", {
          summaryFieldsPresent: summaryFieldsPresent(asRecord(result) ?? {}),
        });
        continue;
      }

      diagnostics.productItemsParsedCount += 1;

      if (summary.siteId && summary.siteId.toUpperCase() !== "MLB") {
        reject("PRODUCT_ITEM_WRONG_SITE", {
          itemId: summary.itemId,
          summaryFieldsPresent: summary.summaryFieldsPresent,
        });
        continue;
      }

      if (summary.price !== undefined && summary.price <= 0) {
        reject("PRODUCT_ITEM_SUMMARY_INVALID_PRICE", {
          itemId: summary.itemId,
          summaryFieldsPresent: summary.summaryFieldsPresent,
        });
        continue;
      }

      const summaryCondition = normalizedCondition(summary.condition);

      if (summaryCondition === "used") {
        reject("PRODUCT_ITEM_USED", {
          itemId: summary.itemId,
          summaryFieldsPresent: summary.summaryFieldsPresent,
          hydratedCondition: summaryCondition,
        });
        continue;
      }

      if (summaryCondition === "refurbished") {
        reject("PRODUCT_ITEM_REFURBISHED", {
          itemId: summary.itemId,
          summaryFieldsPresent: summary.summaryFieldsPresent,
          hydratedCondition: summaryCondition,
        });
        continue;
      }

      parsedSummaries.push(summary);
    }

    const summaries = [
      ...new Map(
        parsedSummaries.map((summary) => [summary.itemId, summary]),
      ).values(),
    ].slice(0, 100);
    diagnostics.productItemsUniqueIds = summaries.length;
    diagnostics.productItemsHydrationRequested = summaries.length;
    const candidates: MarketplaceOfferCandidate[] = [];

    for (let offset = 0; offset < summaries.length; offset += 20) {
      const chunk = summaries.slice(offset, offset + 20);
      let hydrationResponse: { body: unknown; httpStatus: number };

      try {
        hydrationResponse = await this.options.client.requestWithStatus(
          `/items?ids=${chunk
            .map((summary) => encodeURIComponent(summary.itemId))
            .join(",")}`,
        );
      } catch (error) {
        const httpStatus =
          error instanceof MercadoLivreApiError ? error.status : null;

        for (const summary of chunk) {
          reject("PRODUCT_ITEM_DETAIL_HTTP_ERROR", {
            itemId: summary.itemId,
            summaryFieldsPresent: summary.summaryFieldsPresent,
            hydrationHttpStatus: httpStatus,
          });
        }
        continue;
      }

      const rows = Array.isArray(hydrationResponse.body)
        ? hydrationResponse.body
        : [];
      const rowsById = new Map<string, { row: unknown; index: number }>();

      rows.forEach((row, index) => {
        const record = asRecord(row);
        const detail = asRecord(record?.body ?? row);
        const itemId = asStringId(detail?.id);

        if (itemId) {
          rowsById.set(itemId, { row, index });
        }
      });

      for (const [index, summary] of chunk.entries()) {
        const matched = rowsById.get(summary.itemId);
        const row = matched?.row ?? rows[index];
        const record = asRecord(row);
        const detail = asRecord(record?.body ?? row);
        const rowStatus =
          asNumber(record?.code) ?? hydrationResponse.httpStatus;
        const baseSample = {
          itemId: summary.itemId,
          summaryFieldsPresent: summary.summaryFieldsPresent,
          hydrationHttpStatus: rowStatus,
        };

        if (!row) {
          reject("PRODUCT_ITEM_DETAIL_NOT_FOUND", baseSample);
          continue;
        }

        if (![200, 206].includes(rowStatus)) {
          reject("PRODUCT_ITEM_DETAIL_HTTP_ERROR", baseSample);
          continue;
        }

        if (!detail) {
          reject("PRODUCT_ITEM_SCHEMA_MISMATCH", baseSample);
          continue;
        }

        const detailId = asStringId(detail.id) ?? summary.itemId;

        if (!isMercadoLivreItemId(detailId)) {
          reject("PRODUCT_ITEM_INVALID_ID", baseSample);
          continue;
        }

        diagnostics.productItemsHydrated += 1;
        const siteId = asString(detail.site_id) ?? summary.siteId ?? null;
        const status = asString(detail.status);
        const conditionFromDetail = resolveMercadoLivreItemCondition(detail);
        const condition =
          conditionFromDetail === "unknown"
            ? normalizedCondition(summary.condition)
            : conditionFromDetail;
        const availableQuantity =
          asNumber(detail.available_quantity) ??
          summary.availableQuantity ??
          null;
        const channelsPresent = Array.isArray(detail.channels);
        const channels = asArray(detail.channels)
          .map(asString)
          .filter((channel): channel is string => Boolean(channel));
        const productUrl = normalizeItemUrl(detail);
        const commonSample = {
          ...baseSample,
          hydratedStatus: status,
          hydratedCondition: condition,
          hydratedAvailableQuantity: availableQuantity,
          hydratedChannels: channels,
          hasPermalink: Boolean(productUrl && isHttpsUrl(productUrl)),
        };

        if (siteId && siteId.toUpperCase() !== "MLB") {
          reject("PRODUCT_ITEM_WRONG_SITE", commonSample);
          continue;
        }

        if (status && status !== "active") {
          reject("PRODUCT_ITEM_INACTIVE", commonSample);
          continue;
        }

        if (condition === "used") {
          reject("PRODUCT_ITEM_USED", commonSample);
          continue;
        }

        if (condition === "refurbished") {
          reject("PRODUCT_ITEM_REFURBISHED", commonSample);
          continue;
        }

        if (availableQuantity === 0) {
          reject("PRODUCT_ITEM_NO_STOCK", commonSample);
          continue;
        }

        if (
          channelsPresent &&
          !channels.some((channel) => channel.toLowerCase() === "marketplace")
        ) {
          reject("PRODUCT_ITEM_NOT_MARKETPLACE", commonSample);
          continue;
        }

        if (!productUrl || !isHttpsUrl(productUrl)) {
          reject("PRODUCT_ITEM_NO_PERMALINK", commonSample);
          continue;
        }

        const title = asString(detail.title);

        if (!title) {
          reject("PRODUCT_ITEM_SCHEMA_MISMATCH", commonSample);
          continue;
        }

        let price: MercadoLivrePrice;
        let priceSource: MercadoLivrePriceSource;

        try {
          const apiPrice = await this.priceService.getPrice(detailId);

          if (apiPrice.currentPrice === null || apiPrice.currentPrice <= 0) {
            throw new Error("Price API returned no usable price.");
          }

          price = apiPrice;
          priceSource = "PRICE_API";
          diagnostics.priceApiFetched += 1;
        } catch {
          const fallbackPrice = asNumber(detail.price) ?? summary.price ?? null;

          if (fallbackPrice === null || fallbackPrice <= 0) {
            diagnostics.priceUnavailable += 1;
            reject("PRODUCT_ITEM_NO_PRICE", {
              ...commonSample,
              hasPrice: false,
            });
            continue;
          }

          price = { currentPrice: fallbackPrice, originalPrice: null };
          priceSource = "ITEM_FALLBACK";
          diagnostics.priceFallbackUsed += 1;
        }

        const shippingStatus = normalizeShipping(detail);
        const freeShipping =
          shippingStatus === "UNKNOWN"
            ? (summary.freeShipping ?? null)
            : shippingStatus === "FREE";
        const stockItem = {
          ...detail,
          ...(availableQuantity !== null
            ? { available_quantity: availableQuantity }
            : {}),
        };
        candidates.push({
          marketplace: "MERCADO_LIVRE",
          externalProductId: detailId,
          title,
          description: null,
          category: asString(detail.category_id),
          imageUrl: asString(detail.thumbnail),
          productUrl,
          affiliateUrl: null,
          currentPrice: price.currentPrice as number,
          originalPrice: price.originalPrice,
          stockStatus: normalizeStock(stockItem),
          shippingStatus,
          freeShipping,
          availableQuantity,
          sellerReputation: summary.sellerReputation ?? null,
          rating: null,
          salesCount: asNumber(detail.sold_quantity),
          sellerId: asStringId(detail.seller_id) ?? summary.sellerId ?? null,
          officialStoreId:
            asStringId(detail.official_store_id) ??
            summary.officialStoreId ??
            null,
          affiliateEligibility: this.eligibility.evaluate(detail),
          trackingStrategy: "DIRECT_AFFILIATE_LINK",
          itemStatus: status,
          itemCondition: condition,
          channels,
          priceSource,
          collectedAt: new Date(),
        });
        diagnostics.productItemsUsable += 1;

        if (diagnostics.samples.length < 3) {
          diagnostics.samples.push({
            itemId: detailId,
            summaryFieldsPresent: summary.summaryFieldsPresent,
            hydrationHttpStatus: rowStatus,
            hydratedStatus: status,
            hydratedCondition: condition,
            hydratedAvailableQuantity: availableQuantity,
            hydratedChannels: channels,
            hasPermalink: true,
            hasPrice: true,
            rejectedReason: null,
          });
        }
      }
    }

    return { summaries, candidates, diagnostics };
  }

  async getUserProduct(userProductId: string) {
    const userProduct = asRecord(
      await this.options.client.request(
        `/user-products/${encodeURIComponent(userProductId)}`,
      ),
    );

    if (!userProduct) {
      return null;
    }

    const user = asRecord(userProduct.user);

    return {
      id: asString(userProduct.id) ?? userProductId,
      userId: asStringId(
        userProduct.user_id ?? userProduct.seller_id ?? user?.id,
      ),
    };
  }

  async getItemsByUserProduct(userId: string, userProductId: string) {
    const body = asRecord(
      await this.options.client.request(
        `/users/${encodeURIComponent(userId)}/items/search?user_product_id=${encodeURIComponent(userProductId)}`,
      ),
    );
    const results = asArray(body?.results);

    return results
      .map((item) => {
        const record = asRecord(item);
        return asStringId(record?.id ?? record?.item_id ?? item);
      })
      .filter((item): item is string => Boolean(item));
  }

  async getBestSellers(categoryId: string) {
    const siteId = this.options.siteId ?? "MLB";
    const body = asRecord(
      await this.options.client.request(
        `/highlights/${encodeURIComponent(siteId)}/category/${encodeURIComponent(categoryId)}`,
      ),
    );
    const content = asArray(body?.content ?? body?.items ?? body?.results);

    return content
      .map(asRecord)
      .filter(isRecord)
      .map((item, index) => ({
        id: asString(item.id ?? item.item_id) ?? "",
        position: asNumber(item.position) ?? index + 1,
        type: normalizeHighlightType(item.type),
        rawType: asString(item.type),
        categoryId,
      }))
      .filter((item) => item.id);
  }

  async probeCategorySearch({
    siteId,
    categoryId,
    limit,
    testPublicAttempt = true,
    shortCircuitOnAuthenticatedSuccess = true,
  }: MercadoLivreCategorySearchProbeInput): Promise<MercadoLivreCategorySearchProbeResult> {
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 20);
    const endpoint = `/sites/${encodeURIComponent(siteId)}/search`;
    const path = `${endpoint}?category=${encodeURIComponent(categoryId)}&limit=${safeLimit}`;

    const runAttempt = async (
      authenticationMode: MercadoLivreCategorySearchProbeAttempt["authenticationMode"],
    ): Promise<MercadoLivreCategorySearchProbeAttempt> => {
      try {
        const body = asRecord(
          await this.options.client.request(
            path,
            {},
            { authentication: authenticationMode },
          ),
        );

        if (!body) {
          return {
            authenticationMode,
            ok: false,
            httpStatus: 200,
            resultsFound: 0,
            usableItemIds: [],
            sample: [],
            errorCode: "INVALID_RESPONSE",
            errorMessage: "Mercado Livre returned an invalid search response.",
          };
        }

        const rows = asArray(body.results);
        const paging = asRecord(body.paging);
        const usableItems = rows
          .map(asRecord)
          .filter(isRecord)
          .map((item) => {
            const itemId = asStringId(item.id);

            if (!itemId) {
              return null;
            }

            const result: MercadoLivreCategorySearchProbeSample = { itemId };
            const title = asString(item.title);
            const price = asNumber(item.price);
            const permalink = asString(item.permalink);

            if (title) result.title = title;
            if (price !== null) result.price = price;
            if (permalink) result.permalink = permalink;
            return result;
          })
          .filter(
            (item): item is MercadoLivreCategorySearchProbeSample =>
              item !== null,
          );

        return {
          authenticationMode,
          ok: true,
          httpStatus: 200,
          resultsFound: asNumber(paging?.total) ?? rows.length,
          usableItemIds: usableItems.map((item) => item.itemId),
          sample: usableItems.slice(0, 5),
        };
      } catch (error) {
        if (error instanceof MercadoLivreApiError) {
          const forbiddenClassification = classifyMercadoLivreForbidden(
            error.details,
          );

          return {
            authenticationMode,
            ok: false,
            httpStatus: error.status,
            resultsFound: 0,
            usableItemIds: [],
            sample: [],
            errorCode: error.status === 429 ? "RATE_LIMITED" : "API_ERROR",
            errorMessage: error.details.message ?? error.message,
            apiError: error.details,
            ...(forbiddenClassification ? { forbiddenClassification } : {}),
          };
        }

        return {
          authenticationMode,
          ok: false,
          resultsFound: 0,
          usableItemIds: [],
          sample: [],
          errorCode:
            error instanceof MercadoLivreInvalidResponseError
              ? "INVALID_RESPONSE"
              : "NETWORK_OR_TIMEOUT",
          errorMessage:
            error instanceof MercadoLivreInvalidResponseError
              ? error.message
              : "Mercado Livre category search did not complete.",
        };
      }
    };

    const authenticatedAttempt = await runAttempt("BEARER_TOKEN");
    let publicAttempt: MercadoLivreCategorySearchProbeAttempt | undefined;

    if (
      testPublicAttempt &&
      (!authenticatedAttempt.ok || !shortCircuitOnAuthenticatedSuccess)
    ) {
      publicAttempt = await runAttempt("PUBLIC");
    }

    const diagnosis =
      authenticatedAttempt.forbiddenClassification ??
      publicAttempt?.forbiddenClassification;

    return {
      method: "GET",
      endpoint,
      parameters: { category: categoryId, limit: safeLimit },
      categoryId,
      authenticatedAttempt,
      ...(publicAttempt ? { publicAttempt } : {}),
      ...(diagnosis ? { diagnosis } : {}),
    };
  }

  private async normalizeItem(item: Record<string, unknown>): Promise<{
    candidate: MarketplaceOfferCandidate | null;
    priceSource?: MercadoLivrePriceSource;
    priceUnavailable: boolean;
  }> {
    const id = asString(item.id);
    const title = asString(item.title);
    const productUrl = normalizeItemUrl(item);
    const category = asString(item.category_id);

    if (!id || !title || !productUrl) {
      return { candidate: null, priceUnavailable: false };
    }

    let price: MercadoLivrePrice;
    let priceSource: MercadoLivrePriceSource;

    try {
      const apiPrice = await this.priceService.getPrice(id);

      if (apiPrice.currentPrice === null || apiPrice.currentPrice <= 0) {
        throw new Error("Mercado Livre price API returned no usable price.");
      }

      price = apiPrice;
      priceSource = "PRICE_API";
    } catch {
      const fallbackPrice = asNumber(item.price);

      if (fallbackPrice === null || fallbackPrice <= 0) {
        return { candidate: null, priceUnavailable: true };
      }

      price = { currentPrice: fallbackPrice, originalPrice: null };
      priceSource = "ITEM_FALLBACK";
    }

    const shippingStatus = normalizeShipping(item);
    const currentPrice = price.currentPrice;

    if (currentPrice === null) {
      return { candidate: null, priceUnavailable: true };
    }

    return {
      candidate: {
        marketplace: "MERCADO_LIVRE",
        externalProductId: id,
        title,
        description: null,
        category,
        imageUrl: asString(item.thumbnail),
        productUrl,
        affiliateUrl: null,
        currentPrice,
        originalPrice: price.originalPrice,
        stockStatus: normalizeStock(item),
        shippingStatus,
        freeShipping: shippingStatus === "FREE",
        availableQuantity: asNumber(item.available_quantity),
        sellerReputation: null,
        rating: null,
        salesCount: asNumber(item.sold_quantity),
        sellerId: asStringId(item.seller_id),
        officialStoreId: asStringId(item.official_store_id),
        affiliateEligibility: this.eligibility.evaluate(item),
        trackingStrategy: "DIRECT_AFFILIATE_LINK",
        itemStatus: asString(item.status),
        channels: asArray(item.channels)
          .map(asString)
          .filter((channel): channel is string => Boolean(channel)),
        priceSource,
        collectedAt: new Date(),
      },
      priceSource,
      priceUnavailable: false,
    };
  }
}

export async function createMercadoLivreConnector(fetchFn?: ApiFetch) {
  const token = await new MercadoLivreTokenService().getValidAccessToken();
  const config = getMercadoLivreConfig();
  return new MercadoLivreConnector({
    client: new MercadoLivreApiClient(
      fetchFn ? { accessToken: token, fetchFn } : { accessToken: token },
    ),
    siteId: config.siteId,
  });
}

export {
  extractMercadoLivreCsrfToken,
  mergeMercadoLivreCookies,
  normalizeMercadoLivreCookie,
  parseMercadoLivreCookie,
} from "./mercadolivre/affiliate-cookie";
export {
  MercadoLivreAffiliateApiError,
  isMercadoLivreAffiliateApiError,
  sanitizeMercadoLivreAffiliateError,
  sanitizeMercadoLivreAffiliateErrorMessage,
  type MercadoLivreAffiliateApiErrorOptions,
  type MercadoLivreAffiliateApiErrorStage,
} from "./mercadolivre/affiliate-errors";
export {
  MercadoLivreAffiliateLinkService,
  normalizeMercadoLivreAffiliateProductUrl,
  normalizeMercadoLivreGeneratedAffiliateUrl,
} from "./mercadolivre/affiliate-link";
export {
  StripeV2MercadoLivreAffiliatePortalAdapter,
  createMercadoLivreAffiliatePortalAdapter,
  type MercadoLivreAffiliateEndpointMode,
  type MercadoLivreAffiliatePortalAdapter,
} from "./mercadolivre/affiliate-portal-adapter";
export {
  emitMercadoLivreOperationalMetric,
  type MercadoLivreOperationalEvent,
  type MercadoLivreOperationalMetricFields,
  type MercadoLivreOperationalMetricWriter,
} from "./mercadolivre/affiliate-observability";
export {
  MercadoLivreAffiliateSessionService,
  type MercadoLivreAffiliateFetch,
  type MercadoLivreAffiliateHttpOptions,
  type ValidateMercadoLivreAffiliateSessionInput,
  type ValidateMercadoLivreAffiliateSessionResult,
  type WarmMercadoLivreAffiliateSessionInput,
  type WarmMercadoLivreAffiliateSessionResult,
} from "./mercadolivre/affiliate-session";
export {
  parseMercadoLivreAffiliateTags,
  selectMercadoLivreAffiliateTag,
  type CreateMercadoLivreAffiliateLinkInput,
  type CreateMercadoLivreAffiliateLinkResult,
  type MercadoLivreAffiliateTag,
} from "./mercadolivre/affiliate-types";
