import { ShopeeOpenApiClient, ShopeeOpenApiError } from "./open-api";
import { resolveShopeeAffiliateConfiguration } from "./config";
import type { ShopeeProductOfferV2Node } from "./official-product-offer-contract";

export type ShopeeProductEnrichment = ShopeeProductOfferV2Node & {
  itemId: string;
  available: boolean | null;
};

export interface ShopeeProductEnrichmentClient {
  enrichItem(itemId: string): Promise<ShopeeProductEnrichment | null>;
}

export type ShopeeEnrichmentItemResult = {
  itemId: string;
  status: "ENRICHED" | "NOT_FOUND" | "FAILED" | "NOT_ATTEMPTED" | "CACHED";
  metadata: ShopeeProductEnrichment | null;
  errorCode: string | null;
};

export type ShopeeEnrichmentResult = {
  status: "DISABLED" | "SUCCEEDED" | "SUCCEEDED_WITH_ERRORS" | "FAILED";
  shortlisted: number;
  attempted: number;
  enriched: number;
  cached: number;
  failed: number;
  notAttempted: number;
  externalRequests: number;
  canonicalAffiliateLinksChanged: 0;
  globalErrorCode: string | null;
  items: ShopeeEnrichmentItemResult[];
};

const GLOBAL_CODES = new Set([
  "SHOPEE_OPEN_API_AUTHENTICATION_FAILED",
  "SHOPEE_OPEN_API_RATE_LIMITED",
  "SHOPEE_OPEN_API_LOCAL_RATE_LIMITED",
  "SHOPEE_OPEN_API_GRAPHQL_ERROR",
  "SHOPEE_OPEN_API_CREDENTIALS_MISSING",
  "SHOPEE_OPEN_API_SCHEMA_MISMATCH",
]);

function code(error: unknown) {
  return error instanceof ShopeeOpenApiError
    ? error.code
    : "SHOPEE_ENRICHMENT_ITEM_FAILED";
}

export function isShopeeEnrichmentGlobalFailure(error: unknown) {
  return GLOBAL_CODES.has(code(error));
}

export class OfficialShopeeProductEnrichmentClient
  implements ShopeeProductEnrichmentClient
{
  constructor(private readonly client: ShopeeOpenApiClient) {}

  async enrichItem(itemId: string) {
    return this.client.productOfferV2({ itemId });
  }
}

export function createOfficialShopeeProductEnrichmentClient(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const configuration = resolveShopeeAffiliateConfiguration(environment);
  return new OfficialShopeeProductEnrichmentClient(
    new ShopeeOpenApiClient(
      {
        appId: environment.SHOPEE_OPEN_API_APP_ID ?? "",
        secret: environment.SHOPEE_OPEN_API_SECRET ?? "",
      },
      {
        timeoutMs: configuration.openApiTimeoutMs,
        rateLimitPerHour: configuration.openApiRateLimitPerHour,
      },
    ),
  );
}

export async function enrichShopeeShortlist(input: {
  itemIds: readonly string[];
  environment?: NodeJS.ProcessEnv;
  client?: ShopeeProductEnrichmentClient;
  cache?: Map<string, ShopeeProductEnrichment | null>;
}): Promise<ShopeeEnrichmentResult> {
  const configuration = resolveShopeeAffiliateConfiguration(
    input.environment ?? process.env,
  );
  const itemIds = [...new Set(input.itemIds)].slice(
    0,
    configuration.enrichmentMaxItems,
  );
  const result: ShopeeEnrichmentResult = {
    status: configuration.enrichmentEnabled ? "SUCCEEDED" : "DISABLED",
    shortlisted: itemIds.length,
    attempted: 0,
    enriched: 0,
    cached: 0,
    failed: 0,
    notAttempted: 0,
    externalRequests: 0,
    canonicalAffiliateLinksChanged: 0,
    globalErrorCode: null,
    items: [],
  };
  if (!configuration.enrichmentEnabled) return result;
  if (!configuration.openApiReady || !input.client) {
    result.status = "FAILED";
    result.globalErrorCode = "SHOPEE_ENRICHMENT_OPEN_API_NOT_READY";
    result.notAttempted = itemIds.length;
    result.items = itemIds.map((itemId) => ({
      itemId,
      status: "NOT_ATTEMPTED",
      metadata: null,
      errorCode: result.globalErrorCode,
    }));
    return result;
  }
  const cache = input.cache ?? new Map<string, ShopeeProductEnrichment | null>();
  for (let index = 0; index < itemIds.length; index += 1) {
    const itemId = itemIds[index]!;
    if (cache.has(itemId)) {
      const metadata = cache.get(itemId) ?? null;
      result.cached += 1;
      if (metadata) result.enriched += 1;
      result.items.push({
        itemId,
        status: "CACHED",
        metadata,
        errorCode: null,
      });
      continue;
    }
    result.attempted += 1;
    result.externalRequests += 1;
    try {
      const metadata = await input.client.enrichItem(itemId);
      cache.set(itemId, metadata);
      if (metadata) result.enriched += 1;
      result.items.push({
        itemId,
        status: metadata ? "ENRICHED" : "NOT_FOUND",
        metadata,
        errorCode: null,
      });
    } catch (error) {
      const errorCode = code(error);
      result.failed += 1;
      result.items.push({
        itemId,
        status: "FAILED",
        metadata: null,
        errorCode,
      });
      if (isShopeeEnrichmentGlobalFailure(error)) {
        result.status = "FAILED";
        result.globalErrorCode = errorCode;
        const remaining = itemIds.slice(index + 1);
        result.notAttempted += remaining.length;
        result.items.push(
          ...remaining.map((remainingItemId) => ({
            itemId: remainingItemId,
            status: "NOT_ATTEMPTED" as const,
            metadata: null,
            errorCode,
          })),
        );
        return result;
      }
    }
  }
  result.status = result.failed > 0 ? "SUCCEEDED_WITH_ERRORS" : "SUCCEEDED";
  return result;
}
