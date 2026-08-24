import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { planShopeePublications } from "./publication";

export function parseShopeePublicationCliArgs(args: readonly string[]) {
  const offerIdIndexes = args.flatMap((value, index) =>
    value === "--offer-id" ? [index] : [],
  );
  const offerId =
    offerIdIndexes.length === 1
      ? args[offerIdIndexes[0]! + 1]?.trim() || null
      : null;
  return {
    command: args[0] ?? "help",
    confirmCreatePublication: args.includes("--confirm-create-publication"),
    offerId,
    argumentError:
      offerIdIndexes.length > 1 ||
      (offerIdIndexes.length === 1 &&
        (offerId === null || offerId.startsWith("-"))),
  };
}

export async function runShopeePublicationCli(
  args: readonly string[],
  dependencies: {
    plan?: typeof planShopeePublications;
    environment?: NodeJS.ProcessEnv;
  } = {},
) {
  if (args.includes("--help") || args.includes("-h") || args[0] === "help") {
    return {
      exitCode: 0,
      output: {
        status: "USAGE",
        commands: [
          "status",
          "preview [--offer-id <Offer.id>]",
          "create [--offer-id <Offer.id>] --confirm-create-publication",
        ],
        externalRequests: 0,
        writes: 0,
        messagesSent: 0,
        stateModified: false,
      },
    };
  }
  const parsed = parseShopeePublicationCliArgs(args);
  if (parsed.argumentError) {
    return {
      exitCode: 2,
      output: {
        status: "FAILED",
        errorCode: "SHOPEE_PUBLICATION_OFFER_ID_INVALID",
        externalRequests: 0,
        writes: 0,
        messagesSent: 0,
        stateModified: false,
      },
    };
  }
  if (!["status", "preview", "create"].includes(parsed.command)) {
    return {
      exitCode: 2,
      output: {
        status: "FAILED",
        errorCode: "SHOPEE_PUBLICATION_COMMAND_INVALID",
      },
    };
  }
  if (parsed.command === "create" && !parsed.confirmCreatePublication) {
    return {
      exitCode: 2,
      output: {
        status: "FAILED",
        errorCode: "SHOPEE_PUBLICATION_NOT_CONFIRMED",
        externalRequests: 0,
        writes: 0,
        publicationsCreated: 0,
        messagesSent: 0,
        stateModified: false,
      },
    };
  }
  const output = await (dependencies.plan ?? planShopeePublications)({
    environment: dependencies.environment ?? process.env,
    preview: parsed.command !== "create",
    confirmCreatePublication: parsed.confirmCreatePublication,
    ...(parsed.offerId ? { offerId: parsed.offerId } : {}),
  });
  return { exitCode: 0, output };
}

async function main() {
  try {
    const result = await runShopeePublicationCli(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result.output, null, 2)}\n`);
    process.exitCode = result.exitCode;
  } catch (error) {
    const code =
      error instanceof Error && /^SHOPEE_[A-Z0-9_]+$/.test(error.message)
        ? error.message
        : "SHOPEE_PUBLICATION_FAILED";
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
