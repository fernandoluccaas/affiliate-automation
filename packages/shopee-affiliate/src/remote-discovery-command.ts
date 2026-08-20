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

function value(args: readonly string[], name: string) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
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

export async function runShopeeRemoteDiscoveryCommand(
  args: readonly string[],
  dependencies: ShopeeRemoteDiscoveryCommandDependencies = {},
) {
  const command = args[0] ?? "status";
  const environment = dependencies.environment ?? process.env;
  const configuration = resolveShopeeAffiliateConfiguration(environment);
  if (command === "status") {
    return {
      status: "SHOPEE_REMOTE_DISCOVERY_STATUS",
      source: configuration.discoverySource,
      enabled: configuration.automatedDiscoveryEnabled,
      openApiReady: configuration.openApiReady,
      remoteDiscoveryReady: configuration.remoteDiscoveryReady,
      contract: SHOPEE_REMOTE_FEED_CONTRACT_STATUS,
      configuredFeedIds: configuration.remoteDiscoveryFeedIds,
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
    return (dependencies.listFeeds ?? listShopeeOfficialFeeds)({
      confirmLiveCall,
      environment,
      ...(dependencies.client ? { client: dependencies.client } : {}),
    });
  }
  const feedId = value(args, "--feed");
  if (!feedId) return blocked("SHOPEE_REMOTE_FEED_ID_REQUIRED");
  if (command === "preview") {
    return (dependencies.preview ?? previewShopeeRemoteDiscovery)({
      feedId,
      confirmLiveCall,
      environment,
      ...(dependencies.client ? { client: dependencies.client } : {}),
    });
  }
  if (command === "run") {
    if (!args.includes("--confirm-import")) {
      return blocked("SHOPEE_REMOTE_IMPORT_NOT_CONFIRMED");
    }
    return (dependencies.run ?? runShopeeAutomatedDiscovery)({
      feedId,
      confirmLiveCall,
      confirmImport: true,
      environment,
      ...(dependencies.client ? { client: dependencies.client } : {}),
    });
  }
  return blocked("SHOPEE_REMOTE_DISCOVERY_COMMAND_INVALID");
}
