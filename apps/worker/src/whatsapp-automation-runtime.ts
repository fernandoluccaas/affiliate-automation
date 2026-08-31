import {
  authorizeWhatsAppWebSend,
  getWhatsAppWebQueueStatus,
  prisma,
  Prisma,
  recordWhatsAppWebPreflight,
  recordWhatsAppWebVisualInspection,
  revokeWhatsAppWebSendAuthorization,
} from "@affiliate/database";
import { getZonedDayRange } from "@affiliate/publication";
import {
  getWhatsAppWebRuntimeConfig,
  WhatsAppGroupsWebPublisher,
  whatsappWebConfigurationFingerprint,
  whatsappWebVisualDraftInspectionFingerprint,
} from "@affiliate/publisher-connectors";
import { resolvePublicTrackingReadiness } from "@affiliate/tracking";
import { ensureShopeePublicationFreshness } from "@affiliate/shopee-affiliate";
import { dispatchAuthorizedWhatsAppPublication } from "./whatsapp-authorized-dispatch";
import {
  runWhatsAppAutomationCycle,
  type WhatsAppAutomationConfiguration,
  type WhatsAppAutomationCycleDependencies,
} from "./whatsapp-automation";
import { createAuthorizedDispatchDependencies } from "./whatsapp-authorized-dispatch";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function safeCode(error: unknown) {
  return error instanceof Error && /^[A-Z0-9_]+$/u.test(error.message)
    ? error.message
    : "WHATSAPP_AUTOMATION_PREFLIGHT_FAILED";
}

async function updateAutomationChannelState(
  channelId: string,
  patch: Record<string, unknown>,
) {
  const channel = await prisma.channel.findUnique({ where: { id: channelId } });
  if (!channel) return;
  await prisma.channel.update({
    where: { id: channel.id },
    data: {
      configuration: {
        ...record(channel.configuration),
        ...patch,
      } as Prisma.InputJsonValue,
    },
  });
}

export function createWhatsAppAutomationRuntimeDependencies(input: {
  configuration: WhatsAppAutomationConfiguration;
  runnerInstanceId: string;
  signal?: AbortSignal;
}): WhatsAppAutomationCycleDependencies {
  const actorId = `AUTO_WHATSAPP_RUNNER:${input.runnerInstanceId}`;
  return {
    now: () => new Date(),
    aborted: () => input.signal?.aborted ?? false,
    async sentToday() {
      const now = new Date();
      const range = getZonedDayRange(now, input.configuration.timezone);
      return prisma.publication.count({
        where: {
          channel: { type: "WHATSAPP_GROUPS" },
          status: "PUBLISHED",
          publishedAt: { gte: range.start, lt: range.end },
        },
      });
    },
    async nextPublication() {
      const channels = await prisma.channel.findMany({
        where: { type: "WHATSAPP_GROUPS", enabled: true },
        orderBy: { id: "asc" },
      });
      for (const channel of channels) {
        const configuration = record(channel.configuration);
        if (
          configuration.publicationMode !== "WEB_EXPERIMENTAL" ||
          configuration.webAutomationEnabled !== true ||
          configuration.webAutomationPaused === true
        ) {
          continue;
        }
        const queue = await getWhatsAppWebQueueStatus(prisma, channel.id);
        if (queue.deliveryUncertainCount > 0) continue;
        if (!queue.activePublicationId) continue;
        const publication = await prisma.publication.findFirst({
          where: {
            id: queue.activePublicationId,
            status: "SCHEDULED",
            scheduledAt: { lte: new Date() },
            attempts: { none: {} },
          },
          select: { id: true },
        });
        if (publication) return { publicationId: publication.id };
      }
      return null;
    },
    async preflight(publicationId) {
      const tracking = resolvePublicTrackingReadiness();
      if (
        (tracking.mode === "LIVE" || input.configuration.mode === "LIVE") &&
        (!tracking.ready || !tracking.baseUrl)
      ) {
        return {
          ready: false,
          reason: tracking.reason ?? "PUBLIC_TRACKING_NOT_READY",
          browserOpened: false,
        };
      }
      try {
        const dispatchDependencies = createAuthorizedDispatchDependencies();
        const context = await dispatchDependencies.loadContext(publicationId);
        if (context.shopeeDispatchRecord) {
          const freshness = await ensureShopeePublicationFreshness({
            publicationId,
            now: new Date(),
          });
          if (!freshness.allowed) {
            return {
              ready: false,
              reason: freshness.reason,
              browserOpened: false,
            };
          }
        }
        const dryRunConfig = {
          ...getWhatsAppWebRuntimeConfig(),
          dryRun: true,
        };
        const publisher = new WhatsAppGroupsWebPublisher({
          config: dryRunConfig,
        });
        const health = await publisher.healthCheck({
          profileKey: context.input.channel.webProfileKey,
        });
        if (health.status !== "CONNECTED") {
          const browserOpened = ![
            "BROWSER_UNAVAILABLE",
            "PROFILE_IN_USE",
            "REDIS_UNAVAILABLE",
            "NOT_INITIALIZED",
            "DISABLED",
          ].includes(health.status);
          const sessionHealth =
            health.status === "LOGIN_REQUIRED"
              ? "LOGIN_REQUIRED"
              : health.status === "BROWSER_UNAVAILABLE"
                ? "BROWSER_UNAVAILABLE"
                : health.status === "PROFILE_IN_USE"
                  ? "PROFILE_LOCKED"
                  : "DEGRADED";
          await updateAutomationChannelState(context.publication.channelId, {
            automationSessionHealth: sessionHealth,
            automationBlockedReason: health.errorCode ?? "WHATSAPP_AUTOMATION_SESSION_DEGRADED",
            automationLastHealthAt: new Date().toISOString(),
          });
          return {
            ready: false,
            reason:
              health.status === "LOGIN_REQUIRED"
                ? "WHATSAPP_AUTOMATION_LOGIN_REQUIRED"
                : health.status === "BROWSER_UNAVAILABLE"
                  ? "WHATSAPP_AUTOMATION_BROWSER_UNAVAILABLE"
                  : health.status === "PROFILE_IN_USE"
                    ? "WHATSAPP_AUTOMATION_PROFILE_LOCKED"
                    : "WHATSAPP_AUTOMATION_SESSION_DEGRADED",
            browserOpened,
          };
        }
        await updateAutomationChannelState(context.publication.channelId, {
          automationSessionHealth: "AUTHENTICATED",
          automationBlockedReason: null,
          automationLastHealthAt: new Date().toISOString(),
        });
        const result = await publisher.preflight(context.input);
        if (result.status !== "READY_TO_COMMIT_SEND") {
          const reason =
            result.errorCode ?? "WHATSAPP_AUTOMATION_SELECTOR_MISMATCH";
          await updateAutomationChannelState(context.publication.channelId, {
            automationSessionHealth: reason.includes("SELECTOR")
              ? "SELECTOR_MISMATCH"
              : "DEGRADED",
            automationBlockedReason: reason,
            automationLastHealthAt: new Date().toISOString(),
          });
          return {
            ready: false,
            reason,
            browserOpened: true,
          };
        }
        const visualFingerprint = whatsappWebVisualDraftInspectionFingerprint({
          channel: context.input.channel,
          messageSnapshot: context.input.message,
          imageSnapshot: context.input.imageUrl,
        });
        await recordWhatsAppWebVisualInspection(prisma, {
          publicationId,
          confirmed: true,
          actorId,
          result: {
            ...result,
            authorizationMode: "AUTO",
            runnerInstanceId: input.runnerInstanceId,
            visualDraftInspectionFingerprint: visualFingerprint,
          },
        });
        await recordWhatsAppWebPreflight(prisma, {
          publicationId,
          ready: true,
          actorId,
          result: {
            ...result,
            authorizationMode: "AUTO",
            runnerInstanceId: input.runnerInstanceId,
          },
        });
        await updateAutomationChannelState(context.publication.channelId, {
          webLastAttemptAt: new Date().toISOString(),
          webLastDryRunStatus: "READY_TO_SEND",
          lastSuccessfulDryRunAt: new Date().toISOString(),
          lastSuccessfulDryRunConfigurationFingerprint:
            whatsappWebConfigurationFingerprint(context.input.channel),
          automationSessionHealth: "READY",
          automationBlockedReason: null,
          automationRunnerInstanceId: input.runnerInstanceId,
        });
        return { ready: true, reason: null, browserOpened: true };
      } catch (error) {
        return { ready: false, reason: safeCode(error), browserOpened: false };
      }
    },
    async authorize(publicationId) {
      const publication = await prisma.publication.findUnique({
        where: { id: publicationId },
        select: { marketplaceSnapshot: true },
      });
      if (!publication) throw new Error("PUBLICATION_NOT_FOUND");
      await authorizeWhatsAppWebSend(prisma, {
        publicationId,
        actorId,
        expiresInMinutes: input.configuration.authorizationExpiryMinutes,
        authorizationMode: "AUTO",
        runnerInstanceId: input.runnerInstanceId,
        marketplace: publication.marketplaceSnapshot,
      });
    },
    revoke: (publicationId, reason) =>
      revokeWhatsAppWebSendAuthorization(prisma, {
        publicationId,
        actorId,
        reason,
      }).then(() => undefined),
    async dispatch(publicationId) {
      const result = await dispatchAuthorizedWhatsAppPublication({
        publicationId,
        confirmSend: true,
      });
      if (result.status === "DELIVERY_UNCERTAIN" && result.channelId) {
        await updateAutomationChannelState(result.channelId, {
          webAutomationPaused: true,
          automationSessionHealth: "DEGRADED",
          automationBlockedReason: "WHATSAPP_WEB_DELIVERY_UNCERTAIN",
          automationBlockedAt: new Date().toISOString(),
        });
      }
      return result;
    },
  };
}

export function runWhatsAppAutomationRuntimeCycle(input: {
  configuration: WhatsAppAutomationConfiguration;
  runnerInstanceId: string;
  signal?: AbortSignal;
}) {
  return runWhatsAppAutomationCycle(
    input.configuration,
    createWhatsAppAutomationRuntimeDependencies(input),
  );
}
