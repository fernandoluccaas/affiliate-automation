import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prisma, type PrismaClient } from "@affiliate/database";
import { scoreShopeeAdvancedCandidate } from "./ranking";

export async function previewPersistedShopeeRanking(
  database: PrismaClient = prisma,
  now = new Date(),
) {
  const offers = await database.offer.findMany({
    where: {
      marketplace: "SHOPEE",
      status: "READY_TO_PUBLISH",
    },
    orderBy: [{ externalProductId: "asc" }, { version: "desc" }],
    include: {
      _count: { select: { clicks: true, conversions: true } },
    },
  });
  const current = new Map<string, (typeof offers)[number]>();
  for (const offer of offers) {
    if (!current.has(offer.externalProductId)) {
      current.set(offer.externalProductId, offer);
    }
  }
  const ranked = [...current.values()]
    .map((offer) => ({
      offerId: offer.id,
      externalProductId: offer.externalProductId,
      category: offer.category,
      ...scoreShopeeAdvancedCandidate({
        itemId: offer.externalProductId,
        qualityScore: offer.score ?? 0,
        salePrice: Number(offer.currentPrice),
        originalPrice:
          offer.originalPrice === null ? null : Number(offer.originalPrice),
        discountPercentage:
          offer.discountPercentage === null
            ? null
            : Number(offer.discountPercentage),
        collectedAt: offer.collectedAt,
        now,
        commissionPercentage:
          offer.commissionPercentage === null
            ? null
            : Number(offer.commissionPercentage),
        clicks: offer._count.clicks,
        conversions: offer._count.conversions,
        publishedAt: offer.publishedAt,
      }),
    }))
    .sort(
      (left, right) =>
        right.score - left.score || left.offerId.localeCompare(right.offerId),
    );
  return {
    status: "SHOPEE_RANKING_PREVIEW",
    candidatePool: ranked.length,
    ranked,
    externalRequests: 0,
    writes: 0,
    messagesSent: 0,
    stateModified: false,
  } as const;
}

export async function runShopeeRankingCli(
  args: readonly string[],
  dependencies: { preview?: typeof previewPersistedShopeeRanking } = {},
) {
  if (args.includes("--help") || args.includes("-h") || args[0] === "help") {
    return {
      exitCode: 0,
      output: {
        status: "USAGE",
        commands: ["preview"],
        externalRequests: 0,
        writes: 0,
        messagesSent: 0,
        stateModified: false,
      },
    };
  }
  const command = args[0] ?? "help";
  if (command !== "preview") {
    return {
      exitCode: 2,
      output: {
        status: "FAILED",
        errorCode: "SHOPEE_RANKING_COMMAND_INVALID",
        stateModified: false,
      },
    };
  }
  return {
    exitCode: 0,
    output: await (dependencies.preview ?? previewPersistedShopeeRanking)(),
  };
}

async function main() {
  const result = await runShopeeRankingCli(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result.output, null, 2)}\n`);
  process.exitCode = result.exitCode;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  void main();
}
