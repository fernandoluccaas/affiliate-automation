import { createHash } from "node:crypto";
import type {
  ShopeeAffiliateLinkProvider,
  ShopeeDatafeedProduct,
} from "./types";
import {
  validateShopeeGeneratedShortLink,
  validateShopeeProductOrigin,
} from "./validation";
import {
  SHOPEE_ITEM_FEED_MAX_PAGE_SIZE,
  ShopeeGetItemFeedDataResponseSchema,
  ShopeeListItemFeedsResponseSchema,
  type ShopeeFeedMode,
} from "./official-feed-contract";

export const SHOPEE_OPEN_API_ENDPOINT =
  "https://open-api.affiliate.shopee.com.br/graphql";

const OFFICIAL_ERROR_CODES = new Map<number, string>([
  [10000, "SHOPEE_OPEN_API_SYSTEM_ERROR"],
  [10010, "SHOPEE_OPEN_API_REQUEST_PARSE_ERROR"],
  [10020, "SHOPEE_OPEN_API_AUTHENTICATION_FAILED"],
  [10030, "SHOPEE_OPEN_API_RATE_LIMITED"],
  [11000, "SHOPEE_OPEN_API_BUSINESS_ERROR"],
]);

export class ShopeeOpenApiError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, retryable = false) {
    super(code);
    this.name = "ShopeeOpenApiError";
    this.code = code;
    this.retryable = retryable;
  }
}

export function createShopeeOpenApiSignature(input: {
  appId: string;
  timestamp: number;
  payload: string;
  secret: string;
}) {
  return createHash("sha256")
    .update(`${input.appId}${input.timestamp}${input.payload}${input.secret}`)
    .digest("hex");
}

export function sanitizeShopeeSubIds(values: readonly string[] | undefined) {
  if (!values) return undefined;
  if (values.length > 5)
    throw new ShopeeOpenApiError("SHOPEE_SUB_IDS_LIMIT_EXCEEDED");
  return values.map((value) => {
    if (!value || value.length > 64 || !/^[A-Za-z0-9]+$/.test(value)) {
      throw new ShopeeOpenApiError("SHOPEE_SUB_ID_INVALID");
    }
    return value;
  });
}

function hasControlCharacter(value: string) {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
  });
}

export function createShopeeGraphQlStringLiteral(value: string) {
  if (hasControlCharacter(value)) {
    throw new ShopeeOpenApiError("SHOPEE_GRAPHQL_STRING_CONTROL_CHARACTER");
  }
  return JSON.stringify(value);
}

export function createGenerateShortLinkPayload(input: {
  originUrl: string;
  subIds?: readonly string[];
}) {
  const subIds = sanitizeShopeeSubIds(input.subIds);
  const fields = [
    `originUrl: ${createShopeeGraphQlStringLiteral(input.originUrl)}`,
  ];
  if (subIds?.length) {
    fields.push(
      `subIds: [${subIds.map(createShopeeGraphQlStringLiteral).join(", ")}]`,
    );
  }
  const query = `mutation {
  generateShortLink(input: {${fields.join(", ")}}) {
    shortLink
    longLink
  }
}`;
  const request = {
    query,
  };
  return { request, body: JSON.stringify(request) };
}

export function createListItemFeedsPayload(feedMode?: ShopeeFeedMode) {
  const argument = feedMode ? `(feedMode: ${feedMode})` : "";
  const request = {
    query: `query {
  listItemFeeds${argument} {
    feeds {
      datafeedId
      referenceId
      datafeedName
      description
      totalCount
      date
      feedMode
    }
  }
}`,
  };
  return { request, body: JSON.stringify(request) };
}

export function createGetItemFeedDataPayload(input: {
  datafeedId: string;
  offset: number;
  limit: number;
}) {
  if (
    !Number.isSafeInteger(input.offset) ||
    input.offset < 0 ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > SHOPEE_ITEM_FEED_MAX_PAGE_SIZE
  ) {
    throw new ShopeeOpenApiError("SHOPEE_REMOTE_DISCOVERY_PAGINATION_INVALID");
  }
  const request = {
    query: `query {
  getItemFeedData(datafeedId: ${createShopeeGraphQlStringLiteral(input.datafeedId)}, offset: ${input.offset}, limit: ${input.limit}) {
    rows {
      columns
      updateType
    }
    pageInfo {
      offset
      limit
      totalCount
      hasMore
    }
  }
}`,
  };
  return { request, body: JSON.stringify(request) };
}

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type GraphQlError = {
  extensions?: { code?: number | string };
};

function graphQlErrorCode(errors: unknown) {
  if (!Array.isArray(errors) || errors.length === 0) return null;
  const raw = (errors[0] as GraphQlError | undefined)?.extensions?.code;
  const numeric = typeof raw === "string" ? Number(raw) : raw;
  return typeof numeric === "number" && Number.isFinite(numeric)
    ? numeric
    : null;
}

export class ShopeeOpenApiClient {
  private readonly calls: number[] = [];

  constructor(
    private readonly credentials: { appId: string; secret: string },
    private readonly dependencies: {
      fetch?: FetchLike;
      now?: () => Date;
      timeoutMs?: number;
      rateLimitPerHour?: number;
      endpoint?: string;
    } = {},
  ) {
    if (!credentials.appId.trim() || !credentials.secret.trim()) {
      throw new ShopeeOpenApiError("SHOPEE_OPEN_API_CREDENTIALS_MISSING");
    }
  }

  private async execute(payload: { body: string }) {
    const now = this.dependencies.now?.() ?? new Date();
    const timestamp = Math.floor(now.getTime() / 1_000);
    const windowStart = timestamp - 3_600;
    while (this.calls[0] !== undefined && this.calls[0] <= windowStart)
      this.calls.shift();
    const rateLimit = Math.min(
      8_000,
      Math.max(1, this.dependencies.rateLimitPerHour ?? 1_000),
    );
    if (this.calls.length >= rateLimit) {
      throw new ShopeeOpenApiError("SHOPEE_OPEN_API_LOCAL_RATE_LIMITED", true);
    }
    this.calls.push(timestamp);
    const signature = createShopeeOpenApiSignature({
      appId: this.credentials.appId,
      timestamp,
      payload: payload.body,
      secret: this.credentials.secret,
    });
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.dependencies.timeoutMs ?? 10_000,
    );
    let response: Response;
    try {
      response = await (this.dependencies.fetch ?? fetch)(
        this.dependencies.endpoint ?? SHOPEE_OPEN_API_ENDPOINT,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `SHA256 Credential=${this.credentials.appId}, Timestamp=${timestamp}, Signature=${signature}`,
          },
          body: payload.body,
          signal: controller.signal,
        },
      );
    } catch {
      if (controller.signal.aborted) {
        throw new ShopeeOpenApiError("SHOPEE_OPEN_API_TIMEOUT", true);
      }
      throw new ShopeeOpenApiError("SHOPEE_OPEN_API_REQUEST_FAILED", true);
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      throw new ShopeeOpenApiError(
        response.status === 429
          ? "SHOPEE_OPEN_API_RATE_LIMITED"
          : "SHOPEE_OPEN_API_HTTP_ERROR",
        response.status === 429 || response.status >= 500,
      );
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new ShopeeOpenApiError("SHOPEE_OPEN_API_RESPONSE_INVALID");
    }
    if (!parsed || typeof parsed !== "object") {
      throw new ShopeeOpenApiError("SHOPEE_OPEN_API_RESPONSE_INVALID");
    }
    const record = parsed as { data?: unknown; errors?: unknown };
    if (Array.isArray(record.errors) && record.errors.length > 0) {
      const officialCode = graphQlErrorCode(record.errors);
      const code = officialCode
        ? OFFICIAL_ERROR_CODES.get(officialCode)
        : undefined;
      throw new ShopeeOpenApiError(
        code ?? "SHOPEE_OPEN_API_GRAPHQL_ERROR",
        officialCode === 10000 || officialCode === 10030,
      );
    }
    if (
      record.data !== undefined &&
      record.data !== null &&
      typeof record.data !== "object"
    ) {
      throw new ShopeeOpenApiError("SHOPEE_OPEN_API_RESPONSE_INVALID");
    }
    return {
      data: (record.data ?? {}) as Record<string, unknown>,
      timestamp,
    };
  }

  async generateShortLink(input: {
    originUrl: string;
    itemId: string;
    subIds?: readonly string[];
  }) {
    if (hasControlCharacter(input.originUrl)) {
      throw new ShopeeOpenApiError("SHOPEE_ORIGIN_URL_INVALID");
    }
    const origin = validateShopeeProductOrigin(input.originUrl, input.itemId);
    if (!origin.ok) throw new ShopeeOpenApiError(origin.code);
    const payload = createGenerateShortLinkPayload({
      originUrl: origin.normalizedUrl,
      ...(input.subIds ? { subIds: input.subIds } : {}),
    });
    const response = await this.execute(payload);
    const generated = response.data.generateShortLink as
      { shortLink?: unknown; longLink?: unknown } | undefined;
    const shortLink = generated?.shortLink;
    if (typeof shortLink !== "string" || !shortLink.trim()) {
      throw new ShopeeOpenApiError("SHOPEE_OPEN_API_SHORT_LINK_MISSING");
    }
    const validated = validateShopeeGeneratedShortLink(shortLink);
    if (!validated.ok) throw new ShopeeOpenApiError(validated.code);
    return {
      affiliateUrl: validated.normalizedUrl,
      provider: "SHOPEE_OPEN_API",
      timestamp: response.timestamp,
    };
  }

  async listItemFeeds(feedMode?: ShopeeFeedMode) {
    const response = await this.execute(createListItemFeedsPayload(feedMode));
    const parsed = ShopeeListItemFeedsResponseSchema.safeParse(
      response.data.listItemFeeds,
    );
    if (!parsed.success) {
      throw new ShopeeOpenApiError("SHOPEE_OPEN_API_SCHEMA_MISMATCH");
    }
    return parsed.data;
  }

  async getItemFeedData(input: {
    datafeedId: string;
    offset?: number;
    limit?: number;
  }) {
    const response = await this.execute(
      createGetItemFeedDataPayload({
        datafeedId: input.datafeedId,
        offset: input.offset ?? 0,
        limit: input.limit ?? SHOPEE_ITEM_FEED_MAX_PAGE_SIZE,
      }),
    );
    const parsed = ShopeeGetItemFeedDataResponseSchema.safeParse(
      response.data.getItemFeedData,
    );
    if (!parsed.success) {
      throw new ShopeeOpenApiError("SHOPEE_OPEN_API_SCHEMA_MISMATCH");
    }
    return parsed.data;
  }
}

export class ShopeeOpenApiAffiliateLinkProvider implements ShopeeAffiliateLinkProvider {
  readonly kind = "OPEN_API" as const;

  constructor(private readonly client: ShopeeOpenApiClient) {}

  async resolve(
    product: ShopeeDatafeedProduct,
    options?: { subIds?: string[] },
  ) {
    const generated = await this.client.generateShortLink({
      originUrl: product.sourceProductUrl,
      itemId: product.itemId,
      ...(options?.subIds ? { subIds: options.subIds } : {}),
    });
    return {
      status: "VERIFIED" as const,
      affiliateUrl: generated.affiliateUrl,
      provider: generated.provider,
    };
  }
}
