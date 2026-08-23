import { describe, expect, it, vi } from "vitest";
import { runShopeePublicationCli } from "./publication-cli";

describe("Shopee publication CLI", () => {
  it("keeps help free of reads and writes", async () => {
    const plan = vi.fn();
    const result = await runShopeePublicationCli(["--help"], { plan });
    expect(result.exitCode).toBe(0);
    expect(plan).not.toHaveBeenCalled();
  });

  it("requires explicit confirmation before creating Publications", async () => {
    const plan = vi.fn();
    const result = await runShopeePublicationCli(["create"], { plan });
    expect(result.exitCode).toBe(2);
    expect(result.output).toMatchObject({
      errorCode: "SHOPEE_PUBLICATION_NOT_CONFIRMED",
      publicationsCreated: 0,
      stateModified: false,
    });
    expect(plan).not.toHaveBeenCalled();
  });
});
