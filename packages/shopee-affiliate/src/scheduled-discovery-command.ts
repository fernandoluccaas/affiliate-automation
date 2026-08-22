import {
  getShopeeScheduledDiscoveryStatus,
  type ShopeeScheduledDiscoveryStatus,
} from "./scheduled-discovery";

export type ShopeeScheduledDiscoveryCommandDependencies = {
  status?: typeof getShopeeScheduledDiscoveryStatus;
  environment?: NodeJS.ProcessEnv;
  now?: Date;
};

export function shopeeScheduledDiscoveryHelp() {
  return {
    status: "SHOPEE_SCHEDULED_DISCOVERY_HELP" as const,
    usage: ["npm run shopee:discovery:auto:status"],
    description:
      "Shows the fail-closed Shopee scheduled discovery decision without external requests or writes.",
    externalRequests: 0 as const,
    writes: 0 as const,
    stateModified: false as const,
  };
}

export async function runShopeeScheduledDiscoveryCommand(
  args: readonly string[],
  dependencies: ShopeeScheduledDiscoveryCommandDependencies = {},
): Promise<
  | ShopeeScheduledDiscoveryStatus
  | ReturnType<typeof shopeeScheduledDiscoveryHelp>
  | {
      status: "FAILED";
      errorCode: "SHOPEE_SCHEDULED_DISCOVERY_COMMAND_INVALID";
      externalRequests: 0;
      writes: 0;
      stateModified: false;
    }
> {
  if (args.includes("--help") || args[0] === "help") {
    return shopeeScheduledDiscoveryHelp();
  }
  const command = args[0] ?? "status";
  if (command !== "status") {
    return {
      status: "FAILED",
      errorCode: "SHOPEE_SCHEDULED_DISCOVERY_COMMAND_INVALID",
      externalRequests: 0,
      writes: 0,
      stateModified: false,
    };
  }
  return (dependencies.status ?? getShopeeScheduledDiscoveryStatus)({
    ...(dependencies.now ? { now: dependencies.now } : {}),
    ...(dependencies.environment
      ? { environment: dependencies.environment }
      : {}),
  });
}
