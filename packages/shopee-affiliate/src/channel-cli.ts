import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  inspectShopeeChannelPolicies,
  updateShopeeChannelPolicy,
} from "./channel";

function option(args: readonly string[], name: string) {
  const positions = args.flatMap((value, index) =>
    value === name ? [index] : [],
  );
  const value =
    positions.length === 1 ? args[positions[0]! + 1]?.trim() : undefined;
  return positions.length === 1 && value && !value.startsWith("-")
    ? value
    : null;
}

function usage() {
  return {
    status: "USAGE",
    commands: [
      "status",
      "preview --channel-id <Channel.id>",
      "enable --channel-id <Channel.id> --confirm-enable-shopee",
      "disable --channel-id <Channel.id> --confirm-disable-shopee",
    ],
    externalRequests: 0,
    writes: 0,
    messagesSent: 0,
    stateModified: false,
  };
}

export async function runShopeeChannelCli(
  args: readonly string[],
  dependencies: {
    inspect?: typeof inspectShopeeChannelPolicies;
    update?: typeof updateShopeeChannelPolicy;
  } = {},
) {
  if (args.includes("--help") || args.includes("-h") || args[0] === "help") {
    return { exitCode: 0, output: usage() };
  }
  const command = args[0] ?? "help";
  if (command === "status") {
    return {
      exitCode: 0,
      output: await (dependencies.inspect ?? inspectShopeeChannelPolicies)(),
    };
  }
  if (!["preview", "enable", "disable"].includes(command)) {
    return {
      exitCode: 2,
      output: {
        ...usage(),
        status: "FAILED",
        errorCode: "SHOPEE_CHANNEL_COMMAND_INVALID",
      },
    };
  }
  const channelId = option(args, "--channel-id");
  if (!channelId) {
    return {
      exitCode: 2,
      output: {
        ...usage(),
        status: "FAILED",
        errorCode: "SHOPEE_CHANNEL_ID_REQUIRED",
      },
    };
  }
  if (command === "preview") {
    return {
      exitCode: 0,
      output: await (dependencies.inspect ?? inspectShopeeChannelPolicies)({
        channelId,
      }),
    };
  }
  const action = command === "enable" ? "ENABLE" : "DISABLE";
  const confirmed = args.includes(
    action === "ENABLE"
      ? "--confirm-enable-shopee"
      : "--confirm-disable-shopee",
  );
  if (!confirmed) {
    return {
      exitCode: 2,
      output: {
        status: "NOT_CONFIRMED",
        errorCode: "SHOPEE_CHANNEL_CHANGE_NOT_CONFIRMED",
        externalRequests: 0,
        writes: 0,
        messagesSent: 0,
        stateModified: false,
      },
    };
  }
  return {
    exitCode: 0,
    output: await (dependencies.update ?? updateShopeeChannelPolicy)({
      channelId,
      action,
      confirmed: true,
    }),
  };
}

async function main() {
  try {
    const result = await runShopeeChannelCli(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result.output, null, 2)}\n`);
    process.exitCode = result.exitCode;
  } catch (error) {
    const errorCode =
      error instanceof Error && /^SHOPEE_[A-Z0-9_]+$/.test(error.message)
        ? error.message
        : "SHOPEE_CHANNEL_FAILED";
    process.stdout.write(
      `${JSON.stringify({ status: "FAILED", errorCode, externalRequests: 0, writes: 0, messagesSent: 0, stateModified: false }, null, 2)}\n`,
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
