import { previewShopeeDispatch } from "@affiliate/shopee-affiliate";
import { dispatchAuthorizedWhatsAppPublication } from "./whatsapp-authorized-dispatch";

function argument(args: string[], name: string) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export async function executeShopeeDispatchCommand(
  args: string[],
  dependencies: {
    preview?: typeof previewShopeeDispatch;
    telegram?: (publicationId: string, channelId: string) => Promise<unknown>;
    whatsapp?: (publicationId: string) => Promise<unknown>;
  } = {},
) {
  const command = args[0];
  if (!command || args.includes("--help") || args.includes("-h")) {
    return {
      status: "HELP",
      usage: [
        "shopee:dispatch:preview -- --publication-id <id> --channel-id <id>",
        "shopee:dispatch:send -- --publication-id <id> --channel-id <id> --confirm-send",
      ],
      externalRequests: 0,
      writes: 0,
      messagesSent: 0,
      stateModified: false,
    } as const;
  }
  const publicationId = argument(args, "--publication-id");
  const channelId = argument(args, "--channel-id");
  if (!publicationId || !channelId)
    throw new Error("SHOPEE_DISPATCH_ID_REQUIRED");
  const preview = await (dependencies.preview ?? previewShopeeDispatch)({
    publicationId,
    channelId,
  });
  if (command === "preview") return preview;
  if (command !== "send") throw new Error("SHOPEE_DISPATCH_COMMAND_INVALID");
  if (!args.includes("--confirm-send")) {
    throw new Error("SHOPEE_DISPATCH_NOT_CONFIRMED");
  }
  if (!preview.allowed) return preview;
  if (preview.channelType === "TELEGRAM") {
    const telegram =
      dependencies.telegram ??
      (async (id: string, selectedChannelId: string) => {
        process.env.AFFILIATE_WORKER_IMPORT_ONLY = "true";
        const { publishScheduledOffers } = await import("./index");
        return publishScheduledOffers(new Date(), {
          publicationId: id,
          channelId: selectedChannelId,
          shopeeScope: "ONLY",
        });
      });
    return telegram(publicationId, channelId);
  }
  if (preview.channelType === "WHATSAPP_GROUPS") {
    return (
      dependencies.whatsapp ??
      ((id) =>
        dispatchAuthorizedWhatsAppPublication({
          publicationId: id,
          confirmSend: true,
        }))
    )(publicationId);
  }
  throw new Error("SHOPEE_DISPATCH_CHANNEL_UNSUPPORTED");
}

async function main() {
  try {
    const result = await executeShopeeDispatchCommand(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const code =
      error instanceof Error && /^SHOPEE_[A-Z0-9_]+$/.test(error.message)
        ? error.message
        : "SHOPEE_DISPATCH_FAILED";
    process.stderr.write(
      `${JSON.stringify({ status: "FAILED", errorCode: code })}\n`,
    );
    process.exitCode = 1;
  }
}

if (process.env.NODE_ENV !== "test") void main();
