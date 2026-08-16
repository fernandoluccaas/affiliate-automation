import { resolveShopeeAffiliateConfiguration } from "./config";
import { ShopeeOpenApiClient, ShopeeOpenApiError } from "./open-api";

export type ShopeeOpenApiSmokeInput = {
  confirmLiveCall: boolean;
  originUrl?: string;
  itemId?: string;
  subIds?: string[];
};

export type ShopeeOpenApiSmokeResult =
  | {
      success: true;
      requestAttempts: 1;
      operation: "GenerateShortLink";
      originItemId: string;
      shortLink: string;
      shortLinkHost: "s.shopee.com.br";
      stateModified: false;
    }
  | {
      success: false;
      requestAttempts: 0 | 1;
      errorCode: string;
      stateModified: false;
    };

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function failure(
  errorCode: string,
  requestAttempts: 0 | 1 = 0,
): ShopeeOpenApiSmokeResult {
  return { success: false, requestAttempts, errorCode, stateModified: false };
}

function sanitizedErrorCode(error: unknown) {
  if (error instanceof ShopeeOpenApiError) return error.code;
  const message = error instanceof Error ? error.message : "";
  return /^SHOPEE_[A-Z0-9_]+$/.test(message)
    ? message
    : "SHOPEE_OPEN_API_SMOKE_FAILED";
}

export async function runShopeeOpenApiSmoke(
  input: ShopeeOpenApiSmokeInput,
  dependencies: {
    environment?: NodeJS.ProcessEnv;
    fetch?: FetchLike;
    now?: () => Date;
  } = {},
): Promise<ShopeeOpenApiSmokeResult> {
  if (!input.confirmLiveCall) return failure("LIVE_CALL_NOT_CONFIRMED");

  const environment = dependencies.environment ?? process.env;
  if (environment.SHOPEE_AFFILIATE_ENABLED !== "true") {
    return failure("SHOPEE_AFFILIATE_DISABLED");
  }
  const configuration = resolveShopeeAffiliateConfiguration(environment);
  if (!configuration.configurationValid) {
    return failure("SHOPEE_AFFILIATE_CONFIGURATION_INVALID");
  }
  if (configuration.mode !== "OPEN_API" && configuration.mode !== "HYBRID") {
    return failure("SHOPEE_OPEN_API_MODE_REQUIRED");
  }
  if (!configuration.openApiReady) {
    return failure("SHOPEE_OPEN_API_CREDENTIALS_MISSING");
  }

  const originUrl = input.originUrl?.trim();
  if (!originUrl) return failure("SHOPEE_ORIGIN_URL_REQUIRED");
  const itemId = input.itemId?.trim();
  if (!itemId) return failure("SHOPEE_ORIGIN_ITEM_ID_REQUIRED");
  if (!/^\d+$/.test(itemId)) return failure("SHOPEE_ORIGIN_ITEM_ID_INVALID");

  const appId = environment.SHOPEE_OPEN_API_APP_ID?.trim();
  const secret = environment.SHOPEE_OPEN_API_SECRET?.trim();
  if (!appId || !secret) {
    return failure("SHOPEE_OPEN_API_CREDENTIALS_MISSING");
  }

  let requestAttempts: 0 | 1 = 0;
  const underlyingFetch = dependencies.fetch ?? fetch;
  const singleAttemptFetch: FetchLike = async (request, init) => {
    if (requestAttempts !== 0) {
      throw new ShopeeOpenApiError("SHOPEE_OPEN_API_MULTIPLE_ATTEMPTS_BLOCKED");
    }
    requestAttempts = 1;
    return underlyingFetch(request, init);
  };

  try {
    const result = await new ShopeeOpenApiClient(
      { appId, secret },
      {
        fetch: singleAttemptFetch,
        ...(dependencies.now ? { now: dependencies.now } : {}),
        timeoutMs: configuration.openApiTimeoutMs,
        rateLimitPerHour: configuration.openApiRateLimitPerHour,
      },
    ).generateShortLink({
      originUrl,
      itemId,
      ...(input.subIds ? { subIds: input.subIds } : {}),
    });
    return {
      success: true,
      requestAttempts: 1,
      operation: "GenerateShortLink",
      originItemId: itemId,
      shortLink: result.affiliateUrl,
      shortLinkHost: "s.shopee.com.br",
      stateModified: false,
    };
  } catch (error) {
    return failure(sanitizedErrorCode(error), requestAttempts);
  }
}

export function serializeShopeeOpenApiSmokeResult(
  result: ShopeeOpenApiSmokeResult,
) {
  return `${JSON.stringify(result, null, 2)}\n`;
}
