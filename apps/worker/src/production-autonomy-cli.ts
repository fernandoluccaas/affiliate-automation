import { prisma } from "@affiliate/database";
import { resolvePublicTrackingReadiness } from "@affiliate/tracking";
import { resolveWhatsAppAutomationConfiguration } from "./whatsapp-automation";

function output(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function snapshot() {
  const [offers, publications, mercadoLivreSession, telegramChannels] = await Promise.all([
    prisma.offer.groupBy({
      by: ["marketplace", "status"],
      _count: { _all: true },
    }),
    prisma.publication.groupBy({
      by: ["marketplaceSnapshot", "status"],
      _count: { _all: true },
    }),
    prisma.mercadoLivreAffiliateSession.findFirst({
      orderBy: { updatedAt: "desc" },
      select: { status: true, lastValidatedAt: true },
    }),
    prisma.channel.count({ where: { type: "TELEGRAM", enabled: true } }),
  ]);
  const publicTracking = resolvePublicTrackingReadiness();
  const whatsapp = resolveWhatsAppAutomationConfiguration();
  return {
    mode: publicTracking.mode,
    publicTracking,
    mercadoLivre: {
      affiliateSession: mercadoLivreSession?.status ?? "NOT_CONFIGURED",
      lastValidatedAt: mercadoLivreSession?.lastValidatedAt?.toISOString() ?? null,
    },
    shopee: {
      enabled: process.env.SHOPEE_AFFILIATE_ENABLED === "true",
      mode: process.env.SHOPEE_AFFILIATE_MODE || "OFF",
      scheduledDiscoveryEnabled:
        process.env.SHOPEE_AUTOMATED_DISCOVERY_ENABLED === "true",
    },
    telegram: {
      enabled: telegramChannels > 0,
      channels: telegramChannels,
      credentialsConfigured: Boolean(
        process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID,
      ),
    },
    whatsapp,
    offers: offers.map((item) => ({
      marketplace: item.marketplace,
      status: item.status,
      count: item._count._all,
    })),
    publications: publications.map((item) => ({
      marketplace: item.marketplaceSnapshot,
      status: item.status,
      count: item._count._all,
    })),
    secretsDisplayed: false,
    externalRequests: 0,
    messagesSent: 0,
    stateModified: false,
  };
}

async function main() {
  const command = process.argv[2] ?? "status";
  if (command !== "status" && command !== "preview") {
    throw new Error("USAGE: status|preview");
  }
  const current = await snapshot();
  output({
    status:
      current.mode === "LIVE" && !current.publicTracking.ready
        ? "BLOCKED"
        : current.mode,
    command: command.toUpperCase(),
    ...current,
  });
}

main()
  .catch((error) => {
    output({
      status: "FAILED",
      errorCode:
        error instanceof Error && /^[A-Z0-9_]+$/u.test(error.message)
          ? error.message
          : "PRODUCTION_AUTONOMY_STATUS_FAILED",
      externalRequests: 0,
      messagesSent: 0,
      stateModified: false,
    });
    process.exitCode = 2;
  })
  .finally(() => prisma.$disconnect());
