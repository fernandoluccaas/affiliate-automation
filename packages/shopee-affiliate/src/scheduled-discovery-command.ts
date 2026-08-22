import {
  getShopeeScheduledDiscoveryStatus,
  runShopeeScheduledDiscoveryTick,
  type ShopeeScheduledDiscoveryStatus,
  type ShopeeScheduledDiscoveryTickResult,
} from "./scheduled-discovery";
import { resolveShopeeAffiliateConfiguration } from "./config";

export type ShopeeScheduledDiscoveryCommandDependencies = {
  status?: typeof getShopeeScheduledDiscoveryStatus;
  tick?: typeof runShopeeScheduledDiscoveryTick;
  environment?: NodeJS.ProcessEnv;
  now?: Date;
};

export function getShopeeScheduledDiscoveryExitCode(result: {
  status?: unknown;
}) {
  if (result.status === "PARTIAL") return 1;
  if (result.status === "FAILED" || result.status === "NOT_READY") return 2;
  return 0;
}

function blocked(errorCode: string) {
  return {
    status: "FAILED" as const,
    errorCode,
    externalRequests: 0 as const,
    writes: 0 as const,
    publicationsCreated: 0 as const,
    messagesSent: 0 as const,
    stateModified: false as const,
  };
}

export function shopeeScheduledDiscoveryHelp() {
  return {
    status: "SHOPEE_SCHEDULED_DISCOVERY_HELP" as const,
    usage: [
      "npm run shopee:discovery:auto:status",
      "npm run shopee:discovery:auto:tick -- --confirm-live-call --confirm-import",
    ],
    description:
      "Status is read-only. Tick requires separate live-call and import confirmations; add --confirm-generate when SHOPEE_AUTO_LINK_AFTER_IMPORT=true. Confirmations never bypass cadence.",
    externalRequests: 0 as const,
    writes: 0 as const,
    publicationsCreated: 0 as const,
    messagesSent: 0 as const,
    stateModified: false as const,
  };
}

export async function runShopeeScheduledDiscoveryCommand(
  args: readonly string[],
  dependencies: ShopeeScheduledDiscoveryCommandDependencies = {},
): Promise<
  | ShopeeScheduledDiscoveryStatus
  | ShopeeScheduledDiscoveryTickResult
  | ReturnType<typeof shopeeScheduledDiscoveryHelp>
  | {
      status: "FAILED";
      errorCode: string;
      externalRequests: 0;
      writes: 0;
      publicationsCreated: 0;
      messagesSent: 0;
      stateModified: false;
    }
> {
  if (args.includes("--help") || args[0] === "help") {
    return shopeeScheduledDiscoveryHelp();
  }
  const command = args[0] ?? "status";
  const environment = dependencies.environment ?? process.env;
  const commonInput = {
    ...(dependencies.now ? { now: dependencies.now } : {}),
    ...(dependencies.environment ? { environment } : {}),
  };
  if (command === "status") {
    return (dependencies.status ?? getShopeeScheduledDiscoveryStatus)(
      commonInput,
    );
  }
  if (command !== "tick") {
    return blocked("SHOPEE_SCHEDULED_DISCOVERY_COMMAND_INVALID");
  }
  if (!args.includes("--confirm-live-call")) {
    return blocked("SHOPEE_SCHEDULED_DISCOVERY_LIVE_CALL_NOT_CONFIRMED");
  }
  if (!args.includes("--confirm-import")) {
    return blocked("SHOPEE_SCHEDULED_DISCOVERY_IMPORT_NOT_CONFIRMED");
  }
  const configuration = resolveShopeeAffiliateConfiguration(environment);
  if (
    configuration.autoLinkAfterImport &&
    !args.includes("--confirm-generate")
  ) {
    return blocked("SHOPEE_SCHEDULED_DISCOVERY_GENERATE_NOT_CONFIRMED");
  }
  return (dependencies.tick ?? runShopeeScheduledDiscoveryTick)(commonInput);
}
