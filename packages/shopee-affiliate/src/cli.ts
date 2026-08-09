import {
  inspectShopeeDatafeeds,
  previewShopeeDatafeeds,
  resolveShopeeAffiliateConfiguration,
} from "./index";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function values(name: string) {
  return process.argv.flatMap((value, index) =>
    value === name && process.argv[index + 1] ? [process.argv[index + 1]!] : [],
  );
}

function output(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function workspaceFile(value: string) {
  if (value.split(/[\\/]/).includes("..")) {
    throw new Error("SHOPEE_DATAFEED_PATH_TRAVERSAL");
  }
  return isAbsolute(value)
    ? value
    : resolve(dirname(fileURLToPath(import.meta.url)), "../../..", value);
}

function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  return /^SHOPEE_[A-Z0-9_]+$/.test(message)
    ? message
    : "SHOPEE_DATAFEED_OPERATION_FAILED";
}

function usage() {
  return {
    status: "USAGE",
    commands: [
      "shopee:datafeed:status",
      "shopee:datafeed:inspect -- --file <CSV> [--file <CSV>]",
      "shopee:datafeed:preview -- --file <CSV> [--file <CSV>]",
    ],
    stateModified: false,
  };
}

async function main() {
  const command = process.argv[2] ?? "help";
  const configuration = resolveShopeeAffiliateConfiguration();
  if (command === "help" || process.argv.includes("--help"))
    return output(usage());
  if (command === "status") {
    return output({
      status: "SHOPEE_DATAFEED_STATUS",
      ...configuration,
      openApiReady: false,
      hybridReady: false,
      datafeedSource: "LOCAL_FILE",
      remoteUrlEnabled: false,
      stateModified: false,
    });
  }
  if (configuration.mode !== "DATAFEED") {
    throw new Error("SHOPEE_DATAFEED_MODE_REQUIRED");
  }
  const files = values("--file").map(workspaceFile);
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  try {
    if (command === "inspect") {
      return output(
        await inspectShopeeDatafeeds({
          files,
          signal: controller.signal,
        }),
      );
    }
    if (command === "preview") {
      return output(
        await previewShopeeDatafeeds({
          files,
          signal: controller.signal,
        }),
      );
    }
    throw new Error("SHOPEE_DATAFEED_COMMAND_INVALID");
  } finally {
    process.removeListener("SIGINT", abort);
  }
}

main().catch((error) => {
  output({
    status: "FAILED",
    errorCode: safeError(error),
    stateModified: false,
  });
  process.exitCode = 2;
});
