import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { prisma, type MarketplaceAccount } from "@affiliate/database";
import { acquireLock } from "@affiliate/redis";
import type { Marketplace, ShippingStatus, StockStatus } from "@affiliate/shared";

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
  shippingStatus?: ShippingStatus;
  stockStatus?: StockStatus;
  sellerId?: string | null;
  officialStoreId?: string | null;
  affiliateEligibility?: "ELIGIBLE" | "INELIGIBLE" | "UNKNOWN";
  affiliateLabel?: string | null;
  trackingStrategy?: "INTERNAL_REDIRECT" | "DIRECT_AFFILIATE_LINK";
  itemStatus?: string | null;
  channels?: string[];
  sourceHighlightId?: string;
  sourceHighlightType?: MercadoLivreHighlightCandidate["type"];
  resolvedProductId?: string;
  resolvedItemId?: string;
  resolutionStrategy?: MercadoLivreResolutionStrategy;
  collectedAt?: Date;
};

export interface MarketplaceConnector {
  marketplace: Marketplace;
  healthCheck(): Promise<boolean>;
  getItem(id: string): Promise<MarketplaceOfferCandidate | null>;
  getItems(ids: string[]): Promise<MarketplaceOfferCandidate[]>;
  getPrice(itemId: string): Promise<MercadoLivrePrice>;
  getSiteCategories(): Promise<MercadoLivreCategoryChild[]>;
  getCategory(categoryId: string): Promise<MercadoLivreCategory | null>;
  getCategoryChildren(categoryId: string): Promise<MercadoLivreCategoryChild[]>;
  getBestSellers(categoryId: string): Promise<MercadoLivreHighlightCandidate[]>;
  getProduct(productId: string): Promise<MercadoLivreProduct | null>;
  getUserProduct(userProductId: string): Promise<MercadoLivreUserProduct | null>;
  getItemsByUserProduct(userId: string, userProductId: string): Promise<string[]>;
  discoverCandidates(categoryIds: string[], options?: { maxCandidatesPerCategory?: number }): Promise<MarketplaceOfferCandidate[]>;
}

export type MercadoLivreEnv = {
  [key: string]: string | undefined;
  MERCADO_LIVRE_CLIENT_ID?: string;
  MERCADO_LIVRE_CLIENT_SECRET?: string;
  MERCADO_LIVRE_REDIRECT_URI?: string;
  MERCADO_LIVRE_SITE_ID?: string;
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
  status: string | null;
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

export type MercadoLivreHighlightSkipReason =
  | "UNSUPPORTED_HIGHLIGHT_TYPE"
  | "PRODUCT_NOT_FOUND"
  | "PRODUCT_PARENT_NO_RESOLVABLE_CHILD"
  | "PRODUCT_LEAF_NO_BUY_BOX_WINNER"
  | "PRODUCT_CHILD_NOT_FOUND"
  | "PRODUCT_CHILD_RESOLUTION_ERROR"
  | "PRODUCT_TREE_DEPTH_LIMIT"
  | "PRODUCT_TREE_SIZE_LIMIT"
  | "USER_PRODUCT_NOT_FOUND"
  | "USER_PRODUCT_NO_USER"
  | "USER_PRODUCT_NO_ACTIVE_ITEM"
  | "CANDIDATE_RESOLUTION_ERROR";

export type MercadoLivreResolutionStrategy =
  | "ITEM_DIRECT"
  | "PRODUCT_DIRECT_BUY_BOX"
  | "PRODUCT_CHILD_BUY_BOX"
  | "USER_PRODUCT_ACTIVE_ITEM";

export type MercadoLivreProductResolutionDiagnostics = {
  productDirectWinnerCount: number;
  productParentCount: number;
  productLeafCount: number;
  productResolvedDirectly: number;
  productResolvedViaChild: number;
  productLeafWithoutWinner: number;
  productParentWithoutResolvableChild: number;
};

export type MercadoLivreResolvedHighlightCandidate = {
  sourceHighlightId: string;
  sourceHighlightType: MercadoLivreHighlightCandidate["type"];
  resolvedProductId?: string;
  resolvedItemId: string;
  resolutionStrategy: MercadoLivreResolutionStrategy;
  position: number;
  categoryId: string;
};

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

function normalizeHighlightType(value: unknown): MercadoLivreHighlightCandidate["type"] {
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
  constructor(
    message: string,
    readonly status: number,
    readonly responseBody?: unknown,
  ) {
    super(message);
    this.name = "MercadoLivreApiError";
  }
}

export class MercadoLivreInvalidResponseError extends Error {
  constructor(message = "Mercado Livre returned an invalid JSON response.") {
    super(message);
    this.name = "MercadoLivreInvalidResponseError";
  }
}

export function getMercadoLivreConfig(env: MercadoLivreEnv = process.env): MercadoLivreConfig {
  return {
    clientId: env.MERCADO_LIVRE_CLIENT_ID?.trim() ?? "",
    clientSecret: env.MERCADO_LIVRE_CLIENT_SECRET?.trim() ?? "",
    redirectUri:
      env.MERCADO_LIVRE_REDIRECT_URI?.trim() ??
      "http://localhost:3000/api/integrations/mercadolivre/callback",
    siteId: env.MERCADO_LIVRE_SITE_ID?.trim() || "MLB",
  };
}

export function buildMercadoLivreAuthorizationUrl(state: string, env: MercadoLivreEnv = process.env) {
  const config = getMercadoLivreConfig(env);
  const url = new URL(MERCADO_LIVRE_AUTH_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

function encryptionKey(env: MercadoLivreEnv = process.env) {
  const secret = env.ENCRYPTION_KEY || env.AUTH_SECRET;

  if (!secret || secret.length < 16) {
    throw new Error("ENCRYPTION_KEY or AUTH_SECRET must be configured to encrypt marketplace tokens.");
  }

  return createHash("sha256").update(secret).digest();
}

export function encryptSecret(value: string, env: MercadoLivreEnv = process.env) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(env), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${encrypted.toString("base64url")}`;
}

export function decryptSecret(value: string, env: MercadoLivreEnv = process.env) {
  const [version, ivValue, tagValue, encryptedValue] = value.split(":");

  if (version !== "v1" || !ivValue || !tagValue || !encryptedValue) {
    throw new Error("Invalid encrypted secret payload.");
  }

  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(env), Buffer.from(ivValue, "base64url"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedValue, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function isRecord(value: Record<string, unknown> | null): value is Record<string, unknown> {
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

function responseErrorMessage(body: unknown, fallback: string) {
  const record = asRecord(body);
  const message = asString(record?.message) ?? asString(record?.error);

  return message ? `${fallback}: ${message}` : fallback;
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

  async request(path: string, init: RequestInit = {}) {
    const url = `${this.options.baseUrl ?? MERCADO_LIVRE_API_BASE_URL}${path}`;
    const retries = this.options.retries ?? 2;
    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const timeout = timeoutSignal(this.options.timeoutMs ?? 10_000);

      try {
        const response = await (this.options.fetchFn ?? fetch)(url, {
          ...init,
          headers: {
            ...(init.headers ?? {}),
            Authorization: `Bearer ${this.options.accessToken}`,
          },
          signal: timeout.signal,
        });

        if (response.ok) {
          try {
            return await response.json();
          } catch {
            throw new MercadoLivreInvalidResponseError();
          }
        }

        if (![429, 500, 502, 503, 504].includes(response.status) || attempt >= retries) {
          let body: unknown;

          try {
            body = await response.json();
          } catch {
            body = undefined;
          }

          const fallback = `Mercado Livre API ${response.status}: ${response.statusText}`;
          throw new MercadoLivreApiError(responseErrorMessage(body, fallback), response.status, body);
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

    throw lastError instanceof Error ? lastError : new Error("Mercado Livre API request failed.");
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
      const response = await (this.options.fetchFn ?? fetch)(`${MERCADO_LIVRE_API_BASE_URL}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
        body: new URLSearchParams(payload).toString(),
        signal: timeout.signal,
      });

      if (!response.ok) {
        throw new Error(`Mercado Livre OAuth ${response.status}: ${response.statusText}`);
      }

      let json: unknown;

      try {
        json = await response.json();
      } catch {
        throw new MercadoLivreInvalidResponseError("Mercado Livre OAuth returned invalid JSON.");
      }

      const body = asRecord(json);

      if (
        !body ||
        typeof body.access_token !== "string" ||
        typeof body.expires_in !== "number" ||
        (typeof body.user_id !== "number" && typeof body.user_id !== "string")
      ) {
        throw new Error("Mercado Livre OAuth returned an invalid token response.");
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
  const refreshTokenEncrypted = token.refresh_token ? encryptSecret(token.refresh_token, env) : undefined;

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
  constructor(private readonly options: { oauth?: MercadoLivreOAuthClient; env?: MercadoLivreEnv } = {}) {}

  async getValidAccessToken() {
    const account = await prisma.marketplaceAccount.findFirst({
      where: { marketplace: "MERCADO_LIVRE", enabled: true },
      orderBy: { updatedAt: "desc" },
    });

    if (!account?.accessTokenEncrypted || !account.expiresAt) {
      throw new Error("Mercado Livre account is not connected.");
    }

    if (account.expiresAt.getTime() - Date.now() > TOKEN_REFRESH_SKEW_MS) {
      return decryptSecret(account.accessTokenEncrypted, this.options.env);
    }

    const lock = await acquireLock(`mercado-livre:token-refresh:${account.id}`, 60_000);

    if (!lock.acquired) {
      const fresh = await prisma.marketplaceAccount.findUnique({ where: { id: account.id } });

      if (fresh?.accessTokenEncrypted) {
        return decryptSecret(fresh.accessTokenEncrypted, this.options.env);
      }

      throw new Error("Mercado Livre token refresh is already running.");
    }

    try {
      return this.refreshAccount(account);
    } finally {
      await lock.release();
    }
  }

  private async refreshAccount(account: MarketplaceAccount) {
    if (!account.refreshTokenEncrypted) {
      await markMercadoLivreAccountError(account.id, "Refresh token is missing.", "REAUTH_REQUIRED");
      throw new Error("Mercado Livre refresh token is missing.");
    }

    try {
      const oauth =
        this.options.oauth ??
        new MercadoLivreOAuthClient(this.options.env ? { env: this.options.env } : {});
      const response = await oauth.refresh(decryptSecret(account.refreshTokenEncrypted, this.options.env));

      if (!response.refresh_token) {
        throw new Error("Mercado Livre did not return a rotated refresh token.");
      }

      await saveMercadoLivreTokenResponse(response, this.options.env);
      return response.access_token;
    } catch (error) {
      await markMercadoLivreAccountError(
        account.id,
        error instanceof Error ? error.message : "Mercado Livre refresh failed.",
        "REAUTH_REQUIRED",
      );
      throw error;
    }
  }
}

export async function markMercadoLivreAccountError(
  accountId: string,
  message: string,
  status: "REAUTH_REQUIRED" | "ERROR" = "ERROR",
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
        message: status === "REAUTH_REQUIRED" ? "MELI_AUTH_EXPIRED" : "MELI_REFRESH_FAILED",
        metadata: { marketplaceAccountId: accountId, error: message },
      },
    }),
  ]);
}

export class MercadoLivrePriceService {
  constructor(private readonly client: MercadoLivreApiClient) {}

  async getPrice(itemId: string): Promise<MercadoLivrePrice> {
    const body = asRecord(await this.client.request(`/items/${encodeURIComponent(itemId)}/prices`));
    const prices = asArray(body?.prices);
    const active = prices.find((price) => asRecord(price)?.type === "standard") ?? prices[0];
    const activeRecord = asRecord(active);
    const amount = asNumber(activeRecord?.amount ?? activeRecord?.regular_amount);
    const metadata = asRecord(activeRecord?.metadata);
    const original = asNumber(metadata?.campaign_discount_original_price ?? activeRecord?.regular_amount);

    return {
      currentPrice: amount,
      originalPrice: original !== null && amount !== null && original > amount ? original : null,
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
  if (item.status !== "active") {
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

function resolvedHighlight(
  candidate: MercadoLivreHighlightCandidate,
  resolvedItemId: string,
  strategy: MercadoLivreResolutionStrategy,
  metadata: { resolvedProductId?: string } = {},
  diagnostics?: MercadoLivreProductResolutionDiagnostics,
): MercadoLivreHighlightResolutionResult {
  return {
    ok: true,
    candidate: {
      sourceHighlightId: candidate.id,
      sourceHighlightType: candidate.type,
      ...(metadata.resolvedProductId ? { resolvedProductId: metadata.resolvedProductId } : {}),
      resolvedItemId,
      resolutionStrategy: strategy,
      position: candidate.position,
      categoryId: candidate.categoryId,
    },
    ...(diagnostics ? { diagnostics } : {}),
  };
}

function skippedHighlight(
  candidate: MercadoLivreHighlightCandidate,
  reason: MercadoLivreHighlightSkipReason,
  diagnostics?: MercadoLivreProductResolutionDiagnostics,
): MercadoLivreHighlightResolutionResult {
  return { ok: false, candidate, reason, ...(diagnostics ? { diagnostics } : {}) };
}

function marketplaceChannels(candidate: MarketplaceOfferCandidate) {
  return (candidate.channels ?? []).map((channel) => channel.toLowerCase());
}

function emptyProductDiagnostics(): MercadoLivreProductResolutionDiagnostics {
  return {
    productDirectWinnerCount: 0,
    productParentCount: 0,
    productLeafCount: 0,
    productResolvedDirectly: 0,
    productResolvedViaChild: 0,
    productLeafWithoutWinner: 0,
    productParentWithoutResolvableChild: 0,
  };
}

function countProductShape(product: MercadoLivreProduct, diagnostics: MercadoLivreProductResolutionDiagnostics) {
  if (product.childrenIds.length > 0) {
    diagnostics.productParentCount += 1;
  } else {
    diagnostics.productLeafCount += 1;
  }

  if (product.buyBoxWinnerItemId) {
    diagnostics.productDirectWinnerCount += 1;
  }
}

function compareNullableNumberDesc(left: number | null, right: number | null) {
  if (left !== null && right !== null && left !== right) {
    return right - left;
  }

  if (left !== null && right === null) {
    return -1;
  }

  if (left === null && right !== null) {
    return 1;
  }

  return 0;
}

function compareNullablePriceAsc(left: number | null, right: number | null) {
  if (left !== null && right !== null && left !== right) {
    return left - right;
  }

  if (left !== null && right === null) {
    return -1;
  }

  if (left === null && right !== null) {
    return 1;
  }

  return 0;
}

type ProductChildCandidate = {
  product: MercadoLivreProduct;
  terminal: boolean;
};

type ProductChildResolution =
  | { ok: true; product: MercadoLivreProduct }
  | { ok: false; reason: MercadoLivreHighlightSkipReason };

export class MercadoLivreHighlightResolver {
  constructor(
    private readonly connector: MarketplaceConnector,
    private readonly options: { maxProductDepth?: number; maxProductsInspected?: number } = {},
  ) {}

  async resolveCandidate(candidate: MercadoLivreHighlightCandidate): Promise<MercadoLivreHighlightResolutionResult> {
    try {
      if (candidate.type === "UNKNOWN") {
        return skippedHighlight(candidate, "UNSUPPORTED_HIGHLIGHT_TYPE");
      }

      if (candidate.type === "ITEM") {
        return resolvedHighlight(candidate, candidate.id, "ITEM_DIRECT");
      }

      if (candidate.type === "PRODUCT") {
        return this.resolveProductCandidate(candidate);
      }

      let userProduct: MercadoLivreUserProduct | null;

      try {
        userProduct = await this.connector.getUserProduct(candidate.id);
      } catch (error) {
        if (error instanceof MercadoLivreApiError && error.status === 404) {
          return skippedHighlight(candidate, "USER_PRODUCT_NOT_FOUND");
        }

        throw error;
      }

      if (!userProduct) {
        return skippedHighlight(candidate, "USER_PRODUCT_NOT_FOUND");
      }

      if (!userProduct.userId) {
        return skippedHighlight(candidate, "USER_PRODUCT_NO_USER");
      }

      const itemIds = await this.connector.getItemsByUserProduct(userProduct.userId, userProduct.id);

      if (itemIds.length === 0) {
        return skippedHighlight(candidate, "USER_PRODUCT_NO_ACTIVE_ITEM");
      }

      const candidates = await this.connector.getItems(itemIds);
      const order = new Map(itemIds.map((itemId, index) => [itemId, index]));
      const [chosen] = candidates
        .filter((item) => item.currentPrice > 0)
        .filter((item) => !item.itemStatus || item.itemStatus === "active")
        .filter((item) => {
          const channels = marketplaceChannels(item);
          return channels.length === 0 || channels.includes("marketplace");
        })
        .sort((left, right) => {
          const leftOrder = order.get(left.externalProductId) ?? Number.MAX_SAFE_INTEGER;
          const rightOrder = order.get(right.externalProductId) ?? Number.MAX_SAFE_INTEGER;

          if (leftOrder !== rightOrder) {
            return leftOrder - rightOrder;
          }

          return left.externalProductId.localeCompare(right.externalProductId);
        });

      if (!chosen) {
        return skippedHighlight(candidate, "USER_PRODUCT_NO_ACTIVE_ITEM");
      }

      return resolvedHighlight(candidate, chosen.externalProductId, "USER_PRODUCT_ACTIVE_ITEM");
    } catch {
      return skippedHighlight(candidate, "CANDIDATE_RESOLUTION_ERROR");
    }
  }

  private async resolveProductCandidate(
    candidate: MercadoLivreHighlightCandidate,
  ): Promise<MercadoLivreHighlightResolutionResult> {
    const diagnostics = emptyProductDiagnostics();
    let product: MercadoLivreProduct | null;

    try {
      product = await this.connector.getProduct(candidate.id);
    } catch (error) {
      if (error instanceof MercadoLivreApiError && error.status === 404) {
        return skippedHighlight(candidate, "PRODUCT_NOT_FOUND", diagnostics);
      }

      throw error;
    }

    if (!product) {
      return skippedHighlight(candidate, "PRODUCT_NOT_FOUND", diagnostics);
    }

    countProductShape(product, diagnostics);

    if (product.buyBoxWinnerItemId) {
      diagnostics.productResolvedDirectly += 1;
      return resolvedHighlight(
        candidate,
        product.buyBoxWinnerItemId,
        "PRODUCT_DIRECT_BUY_BOX",
        { resolvedProductId: product.id },
        diagnostics,
      );
    }

    if (product.childrenIds.length === 0) {
      diagnostics.productLeafWithoutWinner += 1;
      return skippedHighlight(candidate, "PRODUCT_LEAF_NO_BUY_BOX_WINNER", diagnostics);
    }

    const childResolution = await this.resolveProductChildren(product, diagnostics);

    if (!childResolution.ok) {
      if (childResolution.reason === "PRODUCT_PARENT_NO_RESOLVABLE_CHILD") {
        diagnostics.productParentWithoutResolvableChild += 1;
      }

      return skippedHighlight(candidate, childResolution.reason, diagnostics);
    }

    diagnostics.productResolvedViaChild += 1;
    return resolvedHighlight(
      candidate,
      childResolution.product.buyBoxWinnerItemId as string,
      "PRODUCT_CHILD_BUY_BOX",
      { resolvedProductId: childResolution.product.id },
      diagnostics,
    );
  }

  private async resolveProductChildren(
    parent: MercadoLivreProduct,
    diagnostics: MercadoLivreProductResolutionDiagnostics,
  ): Promise<ProductChildResolution> {
    const maxDepth = this.options.maxProductDepth ?? 4;
    const maxProductsInspected = this.options.maxProductsInspected ?? 50;
    const visited = new Set([parent.id]);
    const queue = parent.childrenIds.map((id) => ({ id, depth: 1 }));
    const candidates: ProductChildCandidate[] = [];
    let inspected = 1;
    let loadedChildren = 0;
    let childNotFound = false;
    let childError = false;
    let depthLimited = false;

    while (queue.length > 0) {
      const current = queue.shift();

      if (!current || visited.has(current.id)) {
        continue;
      }

      if (inspected >= maxProductsInspected) {
        return { ok: false, reason: "PRODUCT_TREE_SIZE_LIMIT" };
      }

      visited.add(current.id);
      inspected += 1;

      let product: MercadoLivreProduct | null;

      try {
        product = await this.connector.getProduct(current.id);
      } catch (error) {
        if (error instanceof MercadoLivreApiError && error.status === 404) {
          childNotFound = true;
          continue;
        }

        childError = true;
        continue;
      }

      if (!product) {
        childNotFound = true;
        continue;
      }

      loadedChildren += 1;
      countProductShape(product, diagnostics);

      const terminal = product.childrenIds.length === 0;

      if (product.buyBoxWinnerItemId) {
        candidates.push({ product, terminal });
      }

      if (product.childrenIds.length > 0) {
        if (current.depth >= maxDepth) {
          depthLimited = true;
          continue;
        }

        for (const childId of product.childrenIds) {
          if (!visited.has(childId)) {
            queue.push({ id: childId, depth: current.depth + 1 });
          }
        }
      } else if (!product.buyBoxWinnerItemId) {
        diagnostics.productLeafWithoutWinner += 1;
      }
    }

    const chosen = this.chooseProductChild(candidates);

    if (chosen) {
      return { ok: true, product: chosen };
    }

    if (depthLimited) {
      return { ok: false, reason: "PRODUCT_TREE_DEPTH_LIMIT" };
    }

    if (childError) {
      return { ok: false, reason: "PRODUCT_CHILD_RESOLUTION_ERROR" };
    }

    if (childNotFound && loadedChildren === 0) {
      return { ok: false, reason: "PRODUCT_CHILD_NOT_FOUND" };
    }

    return { ok: false, reason: "PRODUCT_PARENT_NO_RESOLVABLE_CHILD" };
  }

  private chooseProductChild(candidates: ProductChildCandidate[]) {
    const [chosen] = [...candidates].sort((left, right) => {
      const leftActive = left.product.status === "active";
      const rightActive = right.product.status === "active";

      if (leftActive !== rightActive) {
        return leftActive ? -1 : 1;
      }

      if (left.terminal !== right.terminal) {
        return left.terminal ? -1 : 1;
      }

      const soldQuantity = compareNullableNumberDesc(left.product.soldQuantity, right.product.soldQuantity);

      if (soldQuantity !== 0) {
        return soldQuantity;
      }

      const price = compareNullablePriceAsc(left.product.buyBoxWinnerPrice, right.product.buyBoxWinnerPrice);

      if (price !== 0) {
        return price;
      }

      return left.product.id.localeCompare(right.product.id);
    });

    return chosen?.product ?? null;
  }
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
    this.priceService = options.priceService ?? new MercadoLivrePriceService(options.client);
  }

  async healthCheck() {
    try {
      await this.options.client.request(`/sites/${this.options.siteId ?? "MLB"}`);
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
    if (ids.length === 0) {
      return [];
    }

    const chunks: string[][] = [];

    for (let index = 0; index < ids.length; index += 20) {
      chunks.push(ids.slice(index, index + 20));
    }

    const candidates: MarketplaceOfferCandidate[] = [];

    for (const chunk of chunks) {
      const body = await this.options.client.request(`/items?ids=${chunk.map(encodeURIComponent).join(",")}`);
      const rows = Array.isArray(body) ? body : [];

      for (const row of rows) {
        const record = asRecord(row);
        const item = asRecord(record?.body ?? row);

        if (!item) {
          continue;
        }

        const candidate = await this.normalizeItem(item);

        if (candidate) {
          candidates.push(candidate);
        }
      }
    }

    return candidates;
  }

  async getPrice(itemId: string) {
    return this.priceService.getPrice(itemId);
  }

  async getSiteCategories() {
    const siteId = this.options.siteId ?? "MLB";
    const body = await this.options.client.request(`/sites/${encodeURIComponent(siteId)}/categories`);
    return asArray(body)
      .map(asRecord)
      .filter(isRecord)
      .map((item) => ({ id: asString(item.id) ?? "", name: asString(item.name) ?? "" }))
      .filter((item) => item.id);
  }

  async getCategory(categoryId: string) {
    const category = asRecord(await this.options.client.request(`/categories/${encodeURIComponent(categoryId)}`));

    if (!category) {
      return null;
    }

    return {
      id: asString(category.id) ?? categoryId,
      name: asString(category.name) ?? categoryId,
      pathFromRoot: asArray(category.path_from_root)
        .map(asRecord)
        .filter(isRecord)
        .map((item) => ({ id: asString(item.id) ?? "", name: asString(item.name) ?? "" }))
        .filter((item) => item.id),
      children: asArray(category.children_categories)
        .map(asRecord)
        .filter(isRecord)
        .map((item) => ({ id: asString(item.id) ?? "", name: asString(item.name) ?? "" }))
        .filter((item) => item.id),
    };
  }

  async getCategoryChildren(categoryId: string) {
    const category = await this.getCategory(categoryId);
    return category?.children ?? [];
  }

  async getProduct(productId: string) {
    const product = asRecord(await this.options.client.request(`/products/${encodeURIComponent(productId)}`));

    if (!product) {
      return null;
    }

    const buyBoxWinner = asRecord(product.buy_box_winner);
    const childrenIds = asArray(product.children_ids)
      .map(asStringId)
      .filter((item): item is string => Boolean(item));
    const buyBoxWinnerItemId = asStringId(buyBoxWinner?.item_id);
    const parsedProduct = {
      id: asString(product.id) ?? productId,
      name: asString(product.name),
      status: asString(product.status),
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

    console.info("[mercado-livre.product]", {
      productId: parsedProduct.id,
      status: parsedProduct.status,
      childrenCount: parsedProduct.childrenIds.length,
      hasBuyBoxWinner: Boolean(parsedProduct.buyBoxWinnerItemId),
    });

    return parsedProduct;
  }

  async getUserProduct(userProductId: string) {
    const userProduct = asRecord(await this.options.client.request(`/user-products/${encodeURIComponent(userProductId)}`));

    if (!userProduct) {
      return null;
    }

    const user = asRecord(userProduct.user);

    return {
      id: asString(userProduct.id) ?? userProductId,
      userId: asStringId(userProduct.user_id ?? userProduct.seller_id ?? user?.id),
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

  async discoverCandidates(categoryIds: string[], options: { maxCandidatesPerCategory?: number } = {}) {
    const candidates = new Map<string, MercadoLivreResolvedHighlightCandidate>();
    const resolver = new MercadoLivreHighlightResolver(this);

    for (const categoryId of categoryIds) {
      const bestSellers = await this.getBestSellers(categoryId);

      for (const item of bestSellers.slice(0, options.maxCandidatesPerCategory ?? 20)) {
        const result = await resolver.resolveCandidate(item);

        if (!result.ok) {
          continue;
        }

        const existing = candidates.get(result.candidate.resolvedItemId);

        if (!existing || result.candidate.position < existing.position) {
          candidates.set(result.candidate.resolvedItemId, result.candidate);
        }
      }
    }

    const items = await this.getItems([...candidates.keys()]);

    return items.map((item) => {
      const source = candidates.get(item.externalProductId);

      if (!source) {
        return item;
      }

      return {
        ...item,
        sourceHighlightId: source.sourceHighlightId,
        sourceHighlightType: source.sourceHighlightType,
        ...(source.resolvedProductId ? { resolvedProductId: source.resolvedProductId } : {}),
        resolvedItemId: source.resolvedItemId,
        resolutionStrategy: source.resolutionStrategy,
      };
    });
  }

  private async normalizeItem(item: Record<string, unknown>): Promise<MarketplaceOfferCandidate | null> {
    const id = asString(item.id);
    const title = asString(item.title);
    const productUrl = normalizeItemUrl(item);
    const category = asString(item.category_id);

    if (!id || !title || !productUrl) {
      return null;
    }

    const price = await this.priceService.getPrice(id).catch(() => ({
      currentPrice: asNumber(item.price),
      originalPrice: null,
    }));

    if (price.currentPrice === null || price.currentPrice <= 0) {
      return null;
    }

    const shippingStatus = normalizeShipping(item);

    return {
      marketplace: "MERCADO_LIVRE",
      externalProductId: id,
      title,
      description: null,
      category,
      imageUrl: asString(item.thumbnail),
      productUrl,
      affiliateUrl: null,
      currentPrice: price.currentPrice,
      originalPrice: price.originalPrice,
      stockStatus: normalizeStock(item),
      shippingStatus,
      freeShipping: shippingStatus === "FREE",
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
      collectedAt: new Date(),
    };
  }
}

export async function createMercadoLivreConnector(fetchFn?: ApiFetch) {
  const token = await new MercadoLivreTokenService().getValidAccessToken();
  const config = getMercadoLivreConfig();
  return new MercadoLivreConnector({
    client: new MercadoLivreApiClient(fetchFn ? { accessToken: token, fetchFn } : { accessToken: token }),
    siteId: config.siteId,
  });
}
