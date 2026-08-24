import {
  loadCouponIntelligenceStatus,
  previewOfferCoupons,
  refreshOfferCoupons,
} from "./coupon-intelligence-service";

function argument(args: string[], name: string) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export async function executeCouponIntelligenceCommand(args: string[]) {
  const command = args[0];
  if (!command || args.includes("--help") || args.includes("-h")) {
    return {
      status: "HELP",
      usage: [
        "coupons:status",
        "coupons:preview -- --offer-id <Offer.id>",
        "coupons:refresh -- --offer-id <Offer.id> --confirm-refresh",
      ],
      externalRequests: 0,
      writes: 0,
      stateModified: false,
    } as const;
  }
  if (command === "status") return loadCouponIntelligenceStatus();
  const offerId = argument(args, "--offer-id");
  if (!offerId) throw new Error("COUPON_OFFER_ID_REQUIRED");
  if (command === "preview") return previewOfferCoupons({ offerId });
  if (command !== "refresh") throw new Error("COUPON_COMMAND_INVALID");
  return refreshOfferCoupons({
    offerId,
    confirmRefresh: args.includes("--confirm-refresh"),
  });
}

async function main() {
  try {
    const result = await executeCouponIntelligenceCommand(
      process.argv.slice(2),
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const errorCode =
      error instanceof Error && /^[A-Z0-9_]+$/u.test(error.message)
        ? error.message
        : "COUPON_COMMAND_FAILED";
    process.stderr.write(`${JSON.stringify({ status: "FAILED", errorCode })}\n`);
    process.exitCode = 1;
  }
}

if (process.env.NODE_ENV !== "test") void main();
