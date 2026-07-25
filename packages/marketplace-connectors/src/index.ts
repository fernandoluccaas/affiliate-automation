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
  collectedAt?: Date;
};

export interface MarketplaceConnector {
  marketplace: Marketplace;
  healthCheck(): Promise<boolean>;
  getItem(id: string): Promise<MarketplaceOfferCandidate | null>;
  getItems(ids: string[]): Promise<MarketplaceOfferCandidate[]>;
  getPrice(itemId: string): Promise<MercadoLivrePrice>;
  getCategory(categoryId: string): Promise<MercadoLivreCategory | null>;
  getCategoryChildren(categoryId: string): Promise<MercadoLivreCategoryChild[]>;
  getBestSellers(categoryId: string): Promise<MercadoLivreBestSeller[]>;
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

export type MercadoLivreBestSeller = {
  externalId: string;
  position: number | null;
  type: string | null;
};

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
          throw new MercadoLivreApiError(`Mercado Livre API ${response.status}: ${response.statusText}`, response.status);
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
        externalId: asString(item.id ?? item.item_id) ?? "",
        position: asNumber(item.position) ?? index + 1,
        type: asString(item.type),
      }))
      .filter((item) => item.externalId);
  }

  async discoverCandidates(categoryIds: string[], options: { maxCandidatesPerCategory?: number } = {}) {
    const ids = new Set<string>();

    for (const categoryId of categoryIds) {
      const bestSellers = await this.getBestSellers(categoryId);

      for (const item of bestSellers.slice(0, options.maxCandidatesPerCategory ?? 20)) {
        ids.add(item.externalId);
      }
    }

    return this.getItems([...ids]);
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
