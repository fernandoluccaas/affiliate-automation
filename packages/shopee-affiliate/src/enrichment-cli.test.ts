import { describe, expect, it, vi } from "vitest";
import { runShopeeEnrichmentCli } from "./enrichment-cli";

describe("Shopee enrichment CLI", () => {
  it("keeps help and status free from database and API calls", async () => {
    const countCandidates = vi.fn();
    const help = await runShopeeEnrichmentCli(["preview", "-h"], {
      countCandidates,
    });
    const status = await runShopeeEnrichmentCli(["status"], {
      countCandidates,
    });
    expect(countCandidates).not.toHaveBeenCalled();
    expect(help.output).toMatchObject({
      status: "USAGE",
      externalRequests: 0,
      writes: 0,
      messagesSent: 0,
      stateModified: false,
    });
    expect(status.output).toMatchObject({ externalRequests: 0, writes: 0 });
  });

  it("caps the read-only preview without calling Open API", async () => {
    const result = await runShopeeEnrichmentCli(["preview"], {
      environment: { SHOPEE_ENRICHMENT_MAX_ITEMS: "24" },
      countCandidates: vi.fn().mockResolvedValue(110_000),
    });
    expect(result.output).toMatchObject({
      candidatePool: 110_000,
      wouldEnrich: 24,
      externalRequests: 0,
      writes: 0,
      stateModified: false,
    });
  });
});
