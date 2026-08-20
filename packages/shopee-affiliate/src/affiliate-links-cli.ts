import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  generateShopeeAffiliateLinksBulk,
  loadShopeeOperationalOfferState,
} from "./operational";
import { resolveShopeeAffiliateConfiguration } from "./config";

type CliDependencies = {
  environment?: NodeJS.ProcessEnv;
  generate?: typeof generateShopeeAffiliateLinksBulk;
  loadState?: typeof loadShopeeOperationalOfferState;
};

export function parseShopeeAffiliateLinksCliArgs(args: readonly string[]) {
  const command = args[0] ?? "help";
  const maxIndex = args.indexOf("--max");
  const rawMax = maxIndex >= 0 ? args[maxIndex + 1] : undefined;
  const maxItems = rawMax === undefined ? undefined : Number(rawMax);
  if (
    maxItems !== undefined &&
    (!Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > 12)
  ) {
    throw new Error("SHOPEE_BULK_LINK_MAX_INVALID");
  }
  return {
    command,
    confirmGenerate: args.includes("--confirm-generate"),
    dryRun: args.includes("--dry-run"),
    ...(maxItems !== undefined ? { maxItems } : {}),
  };
}

export async function runShopeeAffiliateLinksCli(
  args: readonly string[],
  dependencies: CliDependencies = {},
) {
  const parsed = parseShopeeAffiliateLinksCliArgs(args);
  const environment = dependencies.environment ?? process.env;
  const configuration = resolveShopeeAffiliateConfiguration(environment);
  if (parsed.command === "status") {
    const offerState = await (
      dependencies.loadState ?? loadShopeeOperationalOfferState
    )();
    return {
      exitCode: 0,
      output: {
        status: "SHOPEE_AFFILIATE_LINK_STATUS",
        mode: configuration.mode,
        openApiReady: configuration.openApiReady,
        autoLinkEnabled: configuration.autoLinkAfterImport,
        readyForAffiliateLink: offerState.offerCounts.pending,
        readyToPublish: offerState.offerCounts.ready,
        stateModified: false,
      },
    };
  }
  if (parsed.command !== "generate") {
    return {
      exitCode: 0,
      output: {
        status: "USAGE",
        command: "generate --pending [--max 12] [--dry-run|--confirm-generate]",
        stateModified: false,
      },
    };
  }
  if (!parsed.confirmGenerate && !parsed.dryRun) {
    return {
      exitCode: 2,
      output: {
        status: "FAILED",
        errorCode: "SHOPEE_BULK_LINK_NOT_CONFIRMED",
        externalRequests: 0,
        writes: 0,
        stateModified: false,
      },
    };
  }
  const result = await (
    dependencies.generate ?? generateShopeeAffiliateLinksBulk
  )({
    source: "MANUAL_BULK",
    confirmGenerate: parsed.confirmGenerate,
    dryRun: parsed.dryRun,
    ...(parsed.maxItems !== undefined ? { maxItems: parsed.maxItems } : {}),
    subIds: ["sourcedatafeed", "bulk"],
    environment,
  });
  return {
    exitCode:
      result.status === "FAILED"
        ? 2
        : result.status === "SUCCEEDED_WITH_ERRORS"
          ? 1
          : 0,
    output: result,
  };
}

function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  return /^SHOPEE_[A-Z0-9_]+$/.test(message)
    ? message
    : "SHOPEE_BULK_LINK_FAILED";
}

async function main() {
  try {
    const result = await runShopeeAffiliateLinksCli(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result.output, null, 2)}\n`);
    process.exitCode = result.exitCode;
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify(
        {
          status: "FAILED",
          errorCode: safeError(error),
          stateModified: false,
        },
        null,
        2,
      )}\n`,
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
