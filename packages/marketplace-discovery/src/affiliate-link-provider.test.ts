import { describe, expect, it } from "vitest";
import { ManualAffiliateLinkProvider } from "./affiliate-link-provider";

describe("ManualAffiliateLinkProvider", () => {
  it("never fabricates an affiliate link", async () => {
    const provider = new ManualAffiliateLinkProvider();

    await expect(
      provider.generate({
        marketplace: "MERCADO_LIVRE",
        productUrl: "https://produto.mercadolivre.com.br/MLB-123",
        externalProductId: "MLB123",
      }),
    ).resolves.toEqual({
      status: "MANUAL_REQUIRED",
      reason:
        "Gere o link no Portal oficial do marketplace e importe-o manualmente.",
    });
  });
});
