import { describe, expect, it } from "vitest";
import { executeCouponIntelligenceCommand } from "./coupon-intelligence-cli";

describe("coupon intelligence CLI safety", () => {
  it("documents the three operational commands without side effects", async () => {
    await expect(executeCouponIntelligenceCommand(["--help"])).resolves.toEqual(
      expect.objectContaining({
        status: "HELP",
        externalRequests: 0,
        writes: 0,
        stateModified: false,
      }),
    );
  });

  it("fails before database or provider access without refresh confirmation", async () => {
    await expect(
      executeCouponIntelligenceCommand([
        "refresh",
        "--offer-id",
        "offer-1",
      ]),
    ).rejects.toThrow("COUPON_REFRESH_NOT_CONFIRMED");
  });
});
