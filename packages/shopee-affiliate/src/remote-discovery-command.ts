import {
  SHOPEE_REMOTE_FEED_CONTRACT_STATUS,
  listShopeeOfficialFeeds,
  previewShopeeRemoteDiscovery,
  runShopeeAutomatedDiscovery,
  type ShopeeRemoteFeedClient,
} from "./remote-discovery";
import { resolveShopeeAffiliateConfiguration } from "./config";

export type ShopeeRemoteDiscoveryCommandDependencies = {
  environment?: NodeJS.ProcessEnv;
  client?: ShopeeRemoteFeedClient;
  listFeeds?: typeof listShopeeOfficialFeeds;
  preview?: typeof previewShopeeRemoteDiscovery;
  run?: typeof runShopeeAutomatedDiscovery;
};

export function getShopeeRemoteDiscoveryExitCode(
  args: readonly string[],
  result: { status?: unknown; errorCode?: unknown },
) {
  const command = args[0] ?? "status";
  if (
    command === "preview" &&
    result.status === "PARTIAL" &&
    result.errorCode === "SHOPEE_REMOTE_DISCOVERY_LIMIT_REACHED"
  ) {
    return 0;
  }
  if (result.status === "FAILED") return 2;
  if (result.status === "PARTIAL") return 1;
  return 0;
}

function value(args: readonly string[], name: string) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function values(args: readonly string[], name: string) {
  return args.flatMap((argument, index) =>
    argument === name && args[index + 1] ? [args[index + 1]!] : [],
  );
}

function numericValue(args: readonly string[], name: string) {
  const raw = value(args, name);
  return raw === undefined ? undefined : Number(raw);
}

function blocked(errorCode: string) {
  return {
    status: "FAILED" as const,
    errorCode,
    externalRequests: 0,
    writes: 0,
    publicationsCreated: 0,
    messagesSent: 0,
    stateModified: false,
  };
}

function sanitizedPreviewRecord(result: Record<string, unknown>) {
  if (!Array.isArray(result.selected)) return result;
  return {
    ...result,
    selected: result.selected.map((item) => {
      const candidate = item as Record<string, unknown>;
      return {
        itemId: candidate.itemId,
        category: candidate.category,
        score: candidate.score,
        salePrice: candidate.salePrice,
        linkStatus: candidate.linkStatus,
        sourceProductHost: candidate.sourceProductHost,
      };
    }),
  };
}

function sanitizedCommandResult<T>(value: T): T {
  if (!value || typeof value !== "object") return value;
  const result = sanitizedPreviewRecord(value as Record<string, unknown>);
  return {
    ...result,
    ...(result.preview && typeof result.preview === "object"
      ? {
          preview: sanitizedPreviewRecord(
            result.preview as Record<string, unknown>,
          ),
        }
      : {}),
  } as T;
}

export async function runShopeeRemoteDiscoveryCommand(
  args: readonly string[],
  dependencies: ShopeeRemoteDiscoveryCommandDependencies = {},
) {
  const command = args[0] ?? "status";
  if (args.includes("--help") || command === "help") {
    return {
      status: "SHOPEE_REMOTE_DISCOVERY_HELP" as const,
      usage: [
        "npm run shopee:feeds:list -- --confirm-live-call",
        "npm run shopee:discovery:remote:preview -- --reference-id <REFERENCE_ID> --confirm-live-call",
        "npm run shopee:discovery:remote:run -- --reference-id <REFERENCE_ID> --confirm-live-call --confirm-import",
      ],
      externalRequests: 0 as const,
      writes: 0 as const,
      publicationsCreated: 0 as const,
      messagesSent: 0 as const,
      stateModified: false as const,
    };
  }
  const environment = dependencies.environment ?? process.env;
  const configuration = resolveShopeeAffiliateConfiguration(environment);
  if (command === "status") {
    return {
      status: "SHOPEE_REMOTE_DISCOVERY_STATUS",
      source: configuration.discoverySource,
      enabled: configuration.automatedDiscoveryEnabled,
      openApiReady: configuration.openApiReady,
      remoteDiscoveryReady: configuration.remoteDiscoveryReady,
      remoteDiscoveryLockConfigured:
        configuration.remoteDiscoveryLockConfigured,
      contract: SHOPEE_REMOTE_FEED_CONTRACT_STATUS,
      readinessState: configuration.remoteDiscoveryState,
      configuredReferenceIds: configuration.remoteDiscoveryReferenceIds,
      configuredFeedIds: configuration.remoteDiscoveryFeedIds,
      pageSize: configuration.remoteDiscoveryPageSize,
      maxPages: configuration.remoteDiscoveryMaxPages,
      maxItems: configuration.remoteDiscoveryMaxItems,
      externalRequests: 0,
      writes: 0,
      stateModified: false,
    };
  }
  const confirmLiveCall = args.includes("--confirm-live-call");
  if (!confirmLiveCall) {
    return blocked("SHOPEE_REMOTE_DISCOVERY_NOT_CONFIRMED");
  }
  if (command === "feeds") {
    const result = await (dependencies.listFeeds ?? listShopeeOfficialFeeds)({
      confirmLiveCall,
      environment,
      ...(dependencies.client ? { client: dependencies.client } : {}),
    });
    return result.status === "SUCCEEDED"
      ? {
          ...result,
          feeds: result.feeds.map((feed) => ({
            referenceId: feed.referenceId,
            datafeedId: feed.datafeedId,
            name: feed.datafeedName,
            totalCount: feed.totalCount,
            date: feed.date,
            feedMode: feed.feedMode,
          })),
        }
      : result;
  }
  const feedIds = values(args, "--feed");
  const referenceIds = values(args, "--reference-id");
  if (
    feedIds.length === 0 &&
    referenceIds.length === 0 &&
    configuration.remoteDiscoveryReferenceIds.length === 0 &&
    configuration.remoteDiscoveryFeedIds.length === 0
  ) {
    return blocked("SHOPEE_REMOTE_FEED_SELECTION_REQUIRED");
  }
  const selection = {
    ...(feedIds.length > 0 ? { feedIds } : {}),
    ...(referenceIds.length > 0 ? { referenceIds } : {}),
    ...(numericValue(args, "--page-size") !== undefined
      ? { pageSize: numericValue(args, "--page-size")! }
      : {}),
    ...(numericValue(args, "--max-pages") !== undefined
      ? { maxPages: numericValue(args, "--max-pages")! }
      : {}),
    ...(numericValue(args, "--max-items") !== undefined
      ? { maxItems: numericValue(args, "--max-items")! }
      : {}),
  };
  if (command === "preview") {
    const result = await (dependencies.preview ?? previewShopeeRemoteDiscovery)(
      {
        ...selection,
        confirmLiveCall,
        environment,
        ...(dependencies.client ? { client: dependencies.client } : {}),
      },
    );
    return sanitizedCommandResult(result);
  }
  if (command === "run") {
    if (!args.includes("--confirm-import")) {
      return blocked("SHOPEE_REMOTE_IMPORT_NOT_CONFIRMED");
    }
    const result = await (dependencies.run ?? runShopeeAutomatedDiscovery)({
      ...selection,
      confirmLiveCall,
      confirmImport: true,
      environment,
      ...(dependencies.client ? { client: dependencies.client } : {}),
    });
    return sanitizedCommandResult(result);
  }
  return blocked("SHOPEE_REMOTE_DISCOVERY_COMMAND_INVALID");
}
