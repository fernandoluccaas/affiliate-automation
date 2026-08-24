import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureShopeePublicationFreshness,
  expireStaleShopeeOffers,
  loadShopeeFreshnessSummary,
} from "./freshness";

function parseSingleOption(args: readonly string[], name: string) {
  const indexes = args.flatMap((value, index) =>
    value === name ? [index] : [],
  );
  const value =
    indexes.length === 1 ? args[indexes[0]! + 1]?.trim() || null : null;
  return {
    value,
    valid: indexes.length === 1 && value !== null && !value.startsWith("-"),
  };
}

export async function loadShopeeFreshnessStatus(
  environment: NodeJS.ProcessEnv = process.env,
  now = new Date(),
) {
  return loadShopeeFreshnessSummary({ environment, now });
}

export async function runShopeeFreshnessCli(
  args: readonly string[],
  dependencies: {
    environment?: NodeJS.ProcessEnv;
    loadStatus?: typeof loadShopeeFreshnessStatus;
    expire?: typeof expireStaleShopeeOffers;
    check?: typeof ensureShopeePublicationFreshness;
  } = {},
) {
  if (args.includes("--help") || args.includes("-h") || args[0] === "help") {
    return {
      exitCode: 0,
      output: {
        status: "USAGE",
        commands: [
          "status",
          "expire --confirm-expire-stale",
          "check --publication-id <Publication.id> --confirm-refresh",
        ],
        externalRequests: 0,
        writes: 0,
        messagesSent: 0,
        stateModified: false,
      },
    };
  }
  const command = args[0] ?? "help";
  if (!["status", "expire", "check"].includes(command)) {
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
  if (command === "check") {
    if (!args.includes("--confirm-refresh")) {
      return {
        exitCode: 2,
        output: {
          status: "NOT_CONFIRMED",
          errorCode: "SHOPEE_FRESHNESS_REFRESH_NOT_CONFIRMED",
          externalRequests: 0,
          writes: 0,
          messagesSent: 0,
          stateModified: false,
        },
      };
    }
    const publicationId = parseSingleOption(args, "--publication-id");
    if (!publicationId.valid) {
      return {
        exitCode: 2,
        output: {
          status: "FAILED",
          errorCode: "SHOPEE_FRESHNESS_PUBLICATION_ID_INVALID",
          externalRequests: 0,
          writes: 0,
          messagesSent: 0,
          stateModified: false,
        },
      };
    }
    return {
      exitCode: 0,
      output: {
        status: "SHOPEE_FRESHNESS_CHECK_COMPLETED",
        ...(await (dependencies.check ?? ensureShopeePublicationFreshness)({
          publicationId: publicationId.value!,
          environment,
        })),
        messagesSent: 0,
      },
    };
  }
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
  try {
    const result = await runShopeeFreshnessCli(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result.output, null, 2)}\n`);
    process.exitCode = result.exitCode;
  } catch (error) {
    const code =
      error instanceof Error && /^SHOPEE_[A-Z0-9_]+$/.test(error.message)
        ? error.message
        : "SHOPEE_FRESHNESS_FAILED";
    process.stdout.write(
      `${JSON.stringify({ status: "FAILED", errorCode: code, stateModified: false }, null, 2)}\n`,
    );
    process.exitCode = 2;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  void main();
}
