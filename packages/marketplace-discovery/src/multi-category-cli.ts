import { prisma } from "@affiliate/database";
import { readFileSync } from "node:fs";
import {
  MercadoLivreDiscoveryService,
  normalizeMultiCategorySettings,
  resolveMultiCategoryRuntimeConfig,
  sanitizeMultiCategorySummary,
  selectBalancedMultiCategoryOffers,
} from "./index";

type Command = "status" | "preflight" | "preview" | "run";

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function flag(name: string) {
  return process.argv.includes(name);
}

function fixtureMode() {
  return process.env.MULTI_CATEGORY_DISCOVERY_FIXTURE_MODE === "true";
}

function fixtureContext() {
  const fixture = JSON.parse(
    readFileSync(
      new URL("../fixtures/multi-category-sanitized.json", import.meta.url),
      "utf8",
    ),
  ) as {
    categories: string[];
    offers: Array<{ offerId: string; categoryId: string }>;
  };
  const settings = normalizeMultiCategorySettings(fixture.categories, []);
  const runtime = resolveMultiCategoryRuntimeConfig(
    {
      MULTI_CATEGORY_DISCOVERY_ENABLED: "true",
      MULTI_CATEGORY_MIN_OFFERS_PER_CATEGORY: "1",
      MULTI_CATEGORY_MAX_OFFERS_PER_CATEGORY: "2",
      MULTI_CATEGORY_MAX_TOTAL_PER_SESSION: "12",
      MULTI_CATEGORY_SELECTION_MODE: "ROUND_ROBIN",
      MULTI_CATEGORY_ALLOW_CATEGORY_BACKFILL: "false",
    },
    { enabled: true },
  );
  const selection = selectBalancedMultiCategoryOffers({
    settings,
    config: runtime,
    candidates: fixture.offers.map((offer, index) => ({
      offerId: offer.offerId,
      productId: `product-${index + 1}`,
      sourceCategoryIds: [offer.categoryId],
      score: 80,
      bestSellerPosition: 1,
      discountPercentage: 20,
      completenessPercentage: 90,
      eligible: true,
      rejectionReason: null,
    })),
  });
  return { settings, runtime, selection };
}

function fixtureResult(command: Command) {
  const fixture = fixtureContext();
  if (command === "status") {
    return {
      command: "discovery:multi-category:status",
      fixture: true,
      enabled: fixture.runtime.enabled,
      selectionMode: fixture.runtime.selectionMode,
      categoriesConfigured: fixture.settings.length,
      maxTotalPerSession: fixture.runtime.maxTotalPerSession,
      externalCalls: false,
      writes: false,
    };
  }
  if (command === "preflight") {
    return {
      command: "discovery:multi-category:preflight",
      fixture: true,
      ok: true,
      failClosed: true,
      categories: fixture.settings.map((setting) => ({
        categoryId: setting.categoryId,
        enabled: setting.enabled,
        isLeaf: setting.isLeaf !== false,
      })),
      issues: [],
      externalCalls: false,
      writes: false,
    };
  }
  return {
    command:
      command === "run"
        ? "discovery:multi-category:run"
        : "discovery:multi-category:preview",
    fixture: true,
    ...(command === "run" ? { dryRun: true } : {}),
    source: "SANITIZED_FIXTURE",
    externalCalls: false,
    writes: false,
    ...sanitizeMultiCategorySummary(fixture.selection),
  };
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

async function context() {
  const [config, latestJob] = await Promise.all([
    prisma.mercadoLivreDiscoveryConfig.findFirst({
      orderBy: { updatedAt: "desc" },
    }),
    prisma.importJob.findFirst({
      where: {
        marketplace: "MERCADO_LIVRE",
        source: "MERCADOLIVRE_BEST_SELLERS",
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        status: true,
        startedAt: true,
        finishedAt: true,
        summary: true,
      },
    }),
  ]);
  const categoryIds = stringArray(config?.categoryIds);
  const settings = normalizeMultiCategorySettings(
    categoryIds,
    config?.multiCategorySettings,
  );
  const runtime = resolveMultiCategoryRuntimeConfig(process.env, {
    enabled: config?.multiCategoryEnabled ?? false,
    ...(config
      ? {
          minOffersPerCategory: config.multiCategoryMinOffersPerCategory,
          maxOffersPerCategory: config.multiCategoryMaxOffersPerCategory,
          maxTotalPerSession: config.multiCategoryMaxTotalPerSession,
          allowCategoryBackfill: config.multiCategoryAllowCategoryBackfill,
        }
      : {}),
    ...(config ? { selectionMode: config.multiCategorySelectionMode } : {}),
  });
  return { config, latestJob, categoryIds, settings, runtime };
}

async function status() {
  const value = await context();
  return {
    command: "discovery:multi-category:status",
    enabled: value.runtime.enabled,
    persistedEnabled: value.config?.multiCategoryEnabled ?? false,
    selectionMode: value.runtime.selectionMode,
    categoriesConfigured: value.settings.length,
    categoriesEnabled: value.settings.filter((setting) => setting.enabled)
      .length,
    minOffersPerCategory: value.runtime.minOffersPerCategory,
    maxOffersPerCategory: value.runtime.maxOffersPerCategory,
    maxTotalPerSession: value.runtime.maxTotalPerSession,
    allowCategoryBackfill: value.runtime.allowCategoryBackfill,
    configurationIssues: value.runtime.issues,
    lastSession: value.latestJob
      ? {
          id: value.latestJob.id,
          status: value.latestJob.status,
          startedAt: value.latestJob.startedAt,
          finishedAt: value.latestJob.finishedAt,
        }
      : null,
  };
}

async function preflight() {
  const value = await context();
  const issues = [...value.runtime.issues];
  if (!value.runtime.enabled) issues.push("MULTI_CATEGORY_DISCOVERY_DISABLED");
  if (value.settings.length === 0) issues.push("NO_CATEGORIES_CONFIGURED");
  if (!value.settings.some((setting) => setting.enabled)) {
    issues.push("NO_CATEGORIES_ENABLED");
  }
  if (value.settings.some((setting) => setting.isLeaf === false)) {
    issues.push("NON_LEAF_CATEGORY_CONFIGURED");
  }
  return {
    command: "discovery:multi-category:preflight",
    ok: issues.length === 0,
    failClosed: true,
    externalCalls: false,
    writes: false,
    categories: value.settings.map((setting) => ({
      categoryId: setting.categoryId,
      enabled: setting.enabled,
      isLeaf: setting.isLeaf !== false,
      priority: setting.priority,
    })),
    issues,
  };
}

async function preview() {
  const value = await context();
  const categoryIds = value.settings
    .filter((setting) => setting.enabled && setting.isLeaf !== false)
    .map((setting) => setting.categoryId);
  const offers =
    categoryIds.length === 0
      ? []
      : await prisma.offer.findMany({
          where: {
            marketplace: "MERCADO_LIVRE",
            sourceCategoryId: { in: categoryIds },
            status: {
              in: [
                "READY_TO_PUBLISH",
                "READY_FOR_AFFILIATE_LINK",
                "SCHEDULED",
                "PUBLISHED",
              ],
            },
          },
          orderBy: { collectedAt: "desc" },
          select: {
            id: true,
            productId: true,
            externalProductId: true,
            sourceCategoryId: true,
            score: true,
            bestSellerPosition: true,
            discountPercentage: true,
            scoreCompletenessPercentage: true,
            affiliateUrl: true,
            status: true,
          },
        });
  const selection = selectBalancedMultiCategoryOffers({
    settings: value.settings,
    config: value.runtime,
    candidates: offers.flatMap((offer) =>
      offer.sourceCategoryId
        ? [
            {
              offerId: offer.id,
              productId: offer.productId ?? offer.externalProductId,
              sourceCategoryIds: [offer.sourceCategoryId],
              score: offer.score,
              bestSellerPosition: offer.bestSellerPosition,
              discountPercentage:
                offer.discountPercentage === null
                  ? null
                  : Number(offer.discountPercentage),
              completenessPercentage:
                offer.scoreCompletenessPercentage === null
                  ? null
                  : Number(offer.scoreCompletenessPercentage),
              eligible:
                Boolean(offer.affiliateUrl) &&
                ["READY_TO_PUBLISH", "SCHEDULED", "PUBLISHED"].includes(
                  offer.status,
                ),
              rejectionReason: offer.affiliateUrl
                ? offer.status
                : "AFFILIATE_LINK_REQUIRED",
            },
          ]
        : [],
    ),
  });
  return {
    command: "discovery:multi-category:preview",
    externalCalls: false,
    writes: false,
    source: "CURRENT_DATABASE_STATE",
    ...sanitizeMultiCategorySummary(selection),
  };
}

async function main() {
  const command = (argument("--command") ?? process.argv[2]) as Command;
  if (fixtureMode()) {
    if (command === "run" && !flag("--dry-run")) {
      return {
        command: "discovery:multi-category:run",
        fixture: true,
        ok: false,
        status: "SKIPPED",
        errorCode: "FIXTURE_MODE_REQUIRES_DRY_RUN",
        externalCalls: false,
        writes: false,
      };
    }
    return fixtureResult(command);
  }
  if (command === "status") return status();
  if (command === "preflight") return preflight();
  if (command === "preview") return preview();
  if (command === "run") {
    if (flag("--dry-run")) {
      return {
        ...(await preview()),
        command: "discovery:multi-category:run",
        dryRun: true,
      };
    }
    if (!flag("--confirm-discovery")) {
      return {
        command: "discovery:multi-category:run",
        ok: false,
        status: "SKIPPED",
        errorCode: "CONFIRM_DISCOVERY_REQUIRED",
        externalCalls: false,
        writes: false,
      };
    }
    const result = await new MercadoLivreDiscoveryService().run(new Date(), {
      force: true,
    });
    return {
      command: "discovery:multi-category:run",
      ok: result.ok,
      status: result.status,
      runId: result.runId ?? null,
      importJobId: result.importJobId ?? null,
      selected: result.selectedOfferIds?.length ?? 0,
      errorCode: result.errorCode ?? null,
    };
  }
  throw new Error("Use status, preflight, preview or run.");
}

main()
  .then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  })
  .catch((error: unknown) => {
    process.stderr.write(
      `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "UNKNOWN_ERROR" })}\n`,
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
