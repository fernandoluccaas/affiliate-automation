import { prisma, Prisma } from "@affiliate/database";
import {
  getWhatsAppWebRuntimeConfig,
  PlaywrightWhatsAppWebBrowserLauncher,
  RedisWhatsAppWebProfileLock,
  resolveWhatsAppWebProfilePath,
  sanitizeWhatsAppWebProfileKey,
  WhatsAppGroupsWebPublisher,
  type WhatsAppWebChannelConfiguration,
  type WhatsAppWebPublicationInput,
} from "@affiliate/publisher-connectors";

function option(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function bool(value: unknown, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}

function channelInput(channel: {
  id: string;
  type: string;
  enabled: boolean;
  name: string;
  configuration: unknown;
}): WhatsAppWebChannelConfiguration {
  const config = record(channel.configuration);
  return {
    channelId: channel.id,
    channelType: channel.type,
    channelEnabled: channel.enabled,
    channelPaused: bool(config.webAutomationPaused),
    publicationMode: text(config.publicationMode, "ASSISTED"),
    groupDisplayName: text(config.groupDisplayName, channel.name),
    webProfileKey: text(config.webProfileKey, "principal"),
    webAutomationEnabled: bool(config.webAutomationEnabled),
    webAutomationOwnershipConfirmed: bool(
      config.webAutomationOwnershipConfirmed,
    ),
    webAutomationConfirmedAt: text(config.webAutomationConfirmedAt) || null,
    sendImage: bool(config.sendImage, true),
    lastSuccessfulDryRunAt: text(config.lastSuccessfulDryRunAt) || null,
    lastSuccessfulDryRunConfigurationFingerprint:
      text(config.lastSuccessfulDryRunConfigurationFingerprint) || null,
  };
}

async function publicationInput(publicationId: string) {
  const publication = await prisma.publication.findUnique({
    where: { id: publicationId },
    include: { channel: true },
  });
  if (!publication) throw new Error("PUBLICATION_NOT_FOUND");
  const payload = record(publication.messagePayload);
  const message = text(payload.message);
  const affiliateUrl = publication.affiliateUrlSnapshot || "";
  if (!message || !affiliateUrl)
    throw new Error("PUBLICATION_SNAPSHOT_INVALID");
  return {
    publication,
    input: {
      publicationId: publication.id,
      offerId: publication.offerId,
      destinationType: "GROUP",
      message,
      affiliateUrl,
      title: publication.offerTitleSnapshot,
      currentPrice: publication.currentPriceSnapshot.toString(),
      imageUrl: publication.imageUrlSnapshot,
      channel: channelInput(publication.channel),
    } satisfies WhatsAppWebPublicationInput,
  };
}

async function updateChannelOperationalState(
  channelId: string,
  patch: Record<string, unknown>,
) {
  const channel = await prisma.channel.findUnique({ where: { id: channelId } });
  if (!channel) return;
  await prisma.channel.update({
    where: { id: channelId },
    data: {
      configuration: {
        ...record(channel.configuration),
        ...patch,
      } as Prisma.InputJsonValue,
    },
  });
}

async function login(profileValue: string) {
  const config = getWhatsAppWebRuntimeConfig();
  const profileKey = sanitizeWhatsAppWebProfileKey(profileValue);
  const launcher = new PlaywrightWhatsAppWebBrowserLauncher();
  if (!(await launcher.isAvailable()))
    throw new Error("WHATSAPP_WEB_BROWSER_UNAVAILABLE");
  const lock = await new RedisWhatsAppWebProfileLock().acquire(
    profileKey,
    config.profileLockTtlMs,
  );
  if (!lock.acquired)
    throw new Error(lock.failureReason || "LOCK_ALREADY_HELD");
  let session: Awaited<ReturnType<typeof launcher.launchPersistent>> | null =
    null;
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const renewal = setInterval(
    () => void lock.extend(config.profileLockTtlMs),
    Math.max(1_000, Math.floor(config.profileLockTtlMs / 3)),
  );
  try {
    session = await launcher.launchPersistent({
      userDataDir: resolveWhatsAppWebProfilePath(
        config.userDataRoot,
        profileKey,
      ),
      headless: false,
      actionTimeoutMs: config.actionTimeoutMs,
      navigationTimeoutMs: config.navigationTimeoutMs,
      confirmationTimeoutMs: config.confirmationTimeoutMs,
      slowMoMs: config.slowMoMs,
    });
    await session.adapter.navigate();
    process.stdout.write(
      "Aguardando login manual no navegador. Nenhum QR ou dado de sessao sera capturado.\n",
    );
    while (!interrupted) {
      const state = await session.adapter.detectAuthenticationState();
      if (state === "CONNECTED") {
        process.stdout.write("CONNECTED\n");
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    clearInterval(renewal);
    await session?.close().catch(() => undefined);
    await lock.release().catch(() => undefined);
  }
}

async function main() {
  const command = process.argv[2];
  const runtimeConfig = getWhatsAppWebRuntimeConfig();
  const localDiagnosticCommand = command === "diagnose" || command === "locate";
  const localDiagnosticKeepOpenOnErrorMs =
    localDiagnosticCommand && runtimeConfig.keepOpenOnError
      ? runtimeConfig.keepOpenOnErrorTimeoutMs
      : 0;
  if (localDiagnosticKeepOpenOnErrorMs > 0) {
    process.stderr.write(
      `Diagnostico local: o browser permanecera aberto por no maximo ${localDiagnosticKeepOpenOnErrorMs}ms somente se houver falha.\n`,
    );
  }
  const publisher = new WhatsAppGroupsWebPublisher({
    config: runtimeConfig,
    localDiagnosticKeepOpenOnErrorMs,
  });

  if (command === "login") {
    await login(option("--profile") || "");
    return;
  }

  if (command === "health") {
    const profileKey = sanitizeWhatsAppWebProfileKey(option("--profile") || "");
    const result = await publisher.healthCheck({ profileKey });
    const channels = await prisma.channel.findMany({
      where: { type: "WHATSAPP_GROUPS" },
      select: { id: true, configuration: true },
    });
    for (const channel of channels) {
      if (
        text(record(channel.configuration).webProfileKey, "principal") ===
        profileKey
      ) {
        await updateChannelOperationalState(channel.id, {
          webLastHealthStatus: result.status,
          webLastHealthAt: result.checkedAt,
          webLastError: result.errorCode ?? null,
        });
      }
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  if (command === "diagnose") {
    const channelId = option("--channel-id");
    if (channelId) {
      const channel = await prisma.channel.findUnique({
        where: { id: channelId },
      });
      if (!channel || channel.type !== "WHATSAPP_GROUPS")
        throw new Error("CHANNEL_NOT_FOUND");
      const input = channelInput(channel);
      const result = await publisher.locateGroup({
        profileKey: input.webProfileKey,
        groupDisplayName: input.groupDisplayName,
      });
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }
    const profileKey = sanitizeWhatsAppWebProfileKey(option("--profile") || "");
    process.stdout.write(
      `${JSON.stringify(await publisher.diagnose({ profileKey }))}\n`,
    );
    return;
  }

  if (command === "locate") {
    const channelId = option("--channel-id");
    if (!channelId) throw new Error("CHANNEL_ID_REQUIRED");
    const channel = await prisma.channel.findUnique({
      where: { id: channelId },
    });
    if (!channel || channel.type !== "WHATSAPP_GROUPS")
      throw new Error("CHANNEL_NOT_FOUND");
    const input = channelInput(channel);
    const result = await publisher.locateGroup({
      profileKey: input.webProfileKey,
      groupDisplayName: input.groupDisplayName,
    });
    await updateChannelOperationalState(channel.id, {
      webLastGroupLocationStatus: result.status,
      webLastGroupLocationAt: new Date().toISOString(),
      webLastError: result.errorCode ?? null,
      webLastDiagnosticStage: result.stage ?? null,
      webLastDiagnosticRootCause: result.rootCause ?? null,
      webLastSafeDiagnostics: result.diagnostics ?? null,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  if (command === "dry-run") {
    const publicationId = option("--publication-id");
    if (!publicationId) throw new Error("PUBLICATION_ID_REQUIRED");
    const { publication, input } = await publicationInput(publicationId);
    const result = await publisher.dryRun(input);
    await updateChannelOperationalState(publication.channelId, {
      webLastAttemptAt: result.dryRunAt,
      webLastDryRunStatus: result.status,
      webLastError: result.errorCode ?? null,
      webLastDryRunStage: result.stage ?? null,
      webLastDryRunDiagnostics: result.diagnostics ?? null,
      ...(result.status === "READY_TO_SEND"
        ? {
            lastSuccessfulDryRunAt: result.dryRunAt,
            lastSuccessfulDryRunConfigurationFingerprint:
              result.configurationFingerprint,
          }
        : {}),
    });
    await prisma.publication.update({
      where: { id: publication.id },
      data: {
        metadata: {
          ...record(publication.metadata),
          ...result,
        } as Prisma.InputJsonValue,
      },
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  if (command === "publish") {
    if (!process.argv.includes("--confirm-send"))
      throw new Error("CONFIRM_SEND_REQUIRED");
    const publicationId = option("--publication-id");
    if (!publicationId) throw new Error("PUBLICATION_ID_REQUIRED");
    const { publication, input } = await publicationInput(publicationId);
    const result = await publisher.publish(input);
    const uncertain = result.status === "DELIVERY_UNCERTAIN";
    await prisma.publication.update({
      where: { id: publication.id },
      data: {
        status:
          result.status === "PUBLISHED" ? "PUBLISHED" : "PUBLICATION_FAILED",
        publishedAt: result.status === "PUBLISHED" ? new Date() : null,
        errorMessage: result.errorCode ?? null,
        metadata: {
          ...record(publication.metadata),
          ...result.metadata,
          rootCause: result.errorCode ?? null,
          retryAuthorized: false,
          deliveryUncertain: uncertain,
        } as Prisma.InputJsonValue,
      },
    });
    if (
      result.status === "PUBLISHED" &&
      getWhatsAppWebRuntimeConfig().autoPauseAfterFirstSuccess
    ) {
      await updateChannelOperationalState(publication.channelId, {
        webAutomationPaused: true,
        webAutomationPauseReason: "WHATSAPP_WEB_FIRST_SUCCESS_REVIEW_REQUIRED",
        webLastSuccessAt: new Date().toISOString(),
      });
    }
    process.stdout.write(
      `${JSON.stringify({ status: result.status, errorCode: result.errorCode })}\n`,
    );
    return;
  }

  throw new Error("USAGE: login|health|diagnose|locate|dry-run|publish");
}

main()
  .catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "WHATSAPP_WEB_UNEXPECTED_STATE"}\n`,
    );
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
