import {
  loadShopeeProductionStatus,
  runShopeeProductionCycle,
} from "@affiliate/shopee-affiliate";

export async function executeShopeeProductionCommand(
  args: string[],
  dependencies: {
    status?: typeof loadShopeeProductionStatus;
    preview?: typeof runShopeeProductionCycle;
    tick?: (now?: Date) => Promise<unknown>;
  } = {},
) {
  const command = args[0];
  if (!command || args.includes("--help") || args.includes("-h")) {
    return {
      status: "HELP",
      usage: [
        "shopee:production:status",
        "shopee:production:preview",
        "shopee:production:tick -- --confirm-run",
      ],
      externalRequests: 0,
      writes: 0,
      messagesSent: 0,
      stateModified: false,
    } as const;
  }
  const loadStatus = dependencies.status ?? loadShopeeProductionStatus;
  if (command === "status") return loadStatus();
  if (command === "preview") {
    const status = await loadStatus();
    return (dependencies.preview ?? runShopeeProductionCycle)({
      confirmRun: false,
      preview: true,
      configuredChannelCount:
        status.mode === "READY" || status.mode === "LIVE" ? 1 : 0,
    });
  }
  if (command !== "tick") throw new Error("SHOPEE_PRODUCTION_COMMAND_INVALID");
  if (!args.includes("--confirm-run")) {
    throw new Error("SHOPEE_PRODUCTION_NOT_CONFIRMED");
  }
  const tick =
    dependencies.tick ??
    (async () => {
      process.env.AFFILIATE_WORKER_IMPORT_ONLY = "true";
      const { runShopeeProductionWorkerStage } = await import("./index");
      return runShopeeProductionWorkerStage(new Date());
    });
  return tick(new Date());
}

async function main() {
  try {
    const result = await executeShopeeProductionCommand(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const code =
      error instanceof Error && /^SHOPEE_[A-Z0-9_]+$/.test(error.message)
        ? error.message
        : "SHOPEE_PRODUCTION_COMMAND_FAILED";
    process.stderr.write(
      `${JSON.stringify({ status: "FAILED", errorCode: code })}\n`,
    );
    process.exitCode = 1;
  }
}

if (process.env.NODE_ENV !== "test") void main();
