import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { planShopeePublications } from "./publication";

export function parseShopeePublicationCliArgs(args: readonly string[]) {
  return {
    command: args[0] ?? "help",
    confirmCreatePublication: args.includes("--confirm-create-publication"),
  };
}

export async function runShopeePublicationCli(
  args: readonly string[],
  dependencies: {
    plan?: typeof planShopeePublications;
    environment?: NodeJS.ProcessEnv;
  } = {},
) {
  const parsed = parseShopeePublicationCliArgs(args);
  if (["help", "--help", "-h"].includes(parsed.command)) {
    return {
      exitCode: 0,
      output: {
        status: "USAGE",
        commands: [
          "status",
          "preview",
          "create --confirm-create-publication",
        ],
        stateModified: false,
      },
    };
  }
  if (!["status", "preview", "create"].includes(parsed.command)) {
    return {
      exitCode: 2,
      output: { status: "FAILED", errorCode: "SHOPEE_PUBLICATION_COMMAND_INVALID" },
    };
  }
  if (parsed.command === "create" && !parsed.confirmCreatePublication) {
    return {
      exitCode: 2,
      output: {
        status: "FAILED",
        errorCode: "SHOPEE_PUBLICATION_NOT_CONFIRMED",
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
