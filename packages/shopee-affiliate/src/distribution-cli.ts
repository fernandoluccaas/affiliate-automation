import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveShopeeAffiliateConfiguration } from "./config";
import { planShopeePublications } from "./publication";

export async function runShopeeDistributionCli(
  args: readonly string[],
  dependencies: {
    environment?: NodeJS.ProcessEnv;
    plan?: typeof planShopeePublications;
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
        errorCode: "SHOPEE_DISTRIBUTION_COMMAND_INVALID",
        stateModified: false,
      },
    };
  }
  const environment = dependencies.environment ?? process.env;
  const configuration = resolveShopeeAffiliateConfiguration(environment);
  const policy = {
    publicationEnabled: configuration.publicationEnabled,
    autoDistributionEnabled: configuration.autoDistributionEnabled,
    telegramEnabled: configuration.publicationTelegramEnabled,
    whatsappEnabled: configuration.publicationWhatsAppEnabled,
    maxPerCycle: configuration.publicationMaxPerCycle,
    maxPerDay: configuration.publicationMaxPerDay,
    minIntervalMinutes: configuration.publicationMinIntervalMinutes,
    windowStart: configuration.publicationWindowStart,
    windowEnd: configuration.publicationWindowEnd,
  };
  if (command === "status") {
    return {
      exitCode: 0,
      output: {
        status: "SHOPEE_DISTRIBUTION_STATUS",
        policy,
        externalRequests: 0,
        writes: 0,
        messagesSent: 0,
        stateModified: false,
      },
    };
  }
  const publicationPreview = await (
    dependencies.plan ?? planShopeePublications
  )({ environment, preview: true });
  return {
    exitCode: 0,
    output: {
      status: "SHOPEE_DISTRIBUTION_PREVIEW",
      policy,
      publicationPreview,
      externalRequests: 0,
      writes: 0,
      messagesSent: 0,
      stateModified: false,
    },
  };
}

async function main() {
  const result = await runShopeeDistributionCli(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result.output, null, 2)}\n`);
  process.exitCode = result.exitCode;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  void main();
}
