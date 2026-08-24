import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "@affiliate/database";
import { resolveShopeeAffiliateConfiguration } from "./config";

export async function inspectShopeeEnrichmentShortlist() {
  return prisma.offer.count({
    where: { marketplace: "SHOPEE", status: "READY_TO_PUBLISH" },
  });
}

export async function runShopeeEnrichmentCli(
  args: readonly string[],
  dependencies: {
    environment?: NodeJS.ProcessEnv;
    countCandidates?: typeof inspectShopeeEnrichmentShortlist;
  } = {},
) {
  if (args.includes("--help") || args.includes("-h") || args[0] === "help") {
    return {
      exitCode: 0,
      output: {
        status: "USAGE",
        commands: ["status", "preview"],
        externalRequests: 0,
        writes: 0,
        messagesSent: 0,
        stateModified: false,
      },
    };
  }
  const command = args[0] ?? "help";
  if (!["status", "preview"].includes(command)) {
    return {
      exitCode: 2,
      output: {
        status: "FAILED",
        errorCode: "SHOPEE_ENRICHMENT_COMMAND_INVALID",
        stateModified: false,
      },
    };
  }
  const configuration = resolveShopeeAffiliateConfiguration(
    dependencies.environment ?? process.env,
  );
  const candidatePool =
    command === "preview"
      ? await (
          dependencies.countCandidates ?? inspectShopeeEnrichmentShortlist
        )()
      : null;
  return {
    exitCode: 0,
    output: {
      status:
        command === "status"
          ? "SHOPEE_ENRICHMENT_STATUS"
          : "SHOPEE_ENRICHMENT_PREVIEW",
      enabled: configuration.enrichmentEnabled,
      openApiReady: configuration.openApiReady,
      maxItems: configuration.enrichmentMaxItems,
      candidatePool,
      wouldEnrich:
        candidatePool === null
          ? null
          : Math.min(candidatePool, configuration.enrichmentMaxItems),
      externalRequests: 0,
      writes: 0,
      messagesSent: 0,
      stateModified: false,
    },
  };
}

async function main() {
  const result = await runShopeeEnrichmentCli(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result.output, null, 2)}\n`);
  process.exitCode = result.exitCode;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  void main();
}
