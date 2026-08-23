import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "@affiliate/database";
import { resolveShopeeAffiliateConfiguration } from "./config";
import {
  evaluateShopeeOfferFreshness,
  expireStaleShopeeOffers,
} from "./freshness";

export async function loadShopeeFreshnessStatus(
  environment: NodeJS.ProcessEnv = process.env,
  now = new Date(),
) {
  const configuration = resolveShopeeAffiliateConfiguration(environment);
  const offers = await prisma.offer.findMany({
    where: {
      marketplace: "SHOPEE",
      status: { in: ["READY_TO_PUBLISH", "SCHEDULED"] },
    },
    select: { collectedAt: true, verifiedAt: true },
  });
  const fresh = offers.filter((offer) =>
    evaluateShopeeOfferFreshness({
      ...offer,
      now,
      maxAgeHours: configuration.publicationMaxOfferAgeHours,
    }),
  ).length;
  return {
    fresh,
    stale: offers.length - fresh,
    maxOfferAgeHours: configuration.publicationMaxOfferAgeHours,
    refreshBeforePublication: configuration.refreshBeforePublication,
  };
}

export async function runShopeeFreshnessCli(
  args: readonly string[],
  dependencies: {
    environment?: NodeJS.ProcessEnv;
    loadStatus?: typeof loadShopeeFreshnessStatus;
    expire?: typeof expireStaleShopeeOffers;
  } = {},
) {
  const command = args[0] ?? "help";
  if (["help", "--help", "-h"].includes(command)) {
    return {
      exitCode: 0,
      output: {
        status: "USAGE",
        commands: ["status", "expire --confirm-expire-stale"],
        stateModified: false,
      },
    };
  }
  if (!["status", "expire"].includes(command)) {
    return {
      exitCode: 2,
      output: {
        status: "FAILED",
        errorCode: "SHOPEE_FRESHNESS_COMMAND_INVALID",
        stateModified: false,
      },
    };
  }
  const environment = dependencies.environment ?? process.env;
  if (command === "status") {
    return {
      exitCode: 0,
      output: {
        status: "SHOPEE_FRESHNESS_STATUS",
        ...(await (dependencies.loadStatus ?? loadShopeeFreshnessStatus)(
          environment,
        )),
        externalRequests: 0,
        writes: 0,
        stateModified: false,
      },
    };
  }
  if (!args.includes("--confirm-expire-stale")) {
    return {
      exitCode: 2,
      output: {
        status: "FAILED",
        errorCode: "SHOPEE_FRESHNESS_NOT_CONFIRMED",
        externalRequests: 0,
        writes: 0,
        stateModified: false,
      },
    };
  }
  return {
    exitCode: 0,
    output: {
      status: "SHOPEE_FRESHNESS_MAINTENANCE_COMPLETED",
      ...(await (dependencies.expire ?? expireStaleShopeeOffers)({
        confirmExpire: true,
        environment,
      })),
      externalRequests: 0,
      messagesSent: 0,
    },
  };
}

async function main() {
  const result = await runShopeeFreshnessCli(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result.output, null, 2)}\n`);
  process.exitCode = result.exitCode;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  void main();
}
