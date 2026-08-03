import { prisma, Prisma } from "@affiliate/database";
import { createInterface } from "node:readline";
import {
  getWhatsAppWebRuntimeConfig,
  PlaywrightWhatsAppWebBrowserLauncher,
  RedisWhatsAppWebProfileLock,
  resolveWhatsAppWebProfilePath,
  sanitizeWhatsAppWebProfileKey,
  WhatsAppGroupsWebPublisher,
  validateRealSendEligibility,
  type WhatsAppWebChannelConfiguration,
  type WhatsAppWebPublicationInput,
  type WhatsAppWebSendStateUpdate,
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

function inspectionHoldMs(defaultMs: number) {
  const raw = option("--hold-ms");
  const value = raw === undefined ? defaultMs : Number(raw);
  if (!Number.isInteger(value) || value < 5_000 || value > 60_000) {
    throw new Error("WHATSAPP_WEB_INSPECT_DRAFT_HOLD_INVALID");
  }
  return value;
}

async function askVisualDraftConfirmation(timeoutMs: number) {
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (confirmed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      readline.close();
      resolve(confirmed);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    readline.question(
      "A imagem e toda a legenda estao visiveis no editor de midia do grupo correto? [s/N] ",
      (answer) => finish(/^s(im)?$/i.test(answer.trim())),
    );
  });
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
      publicationStatus: publication.status,
      publicationMetadata: publication.metadata,
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

async function recordPublicationSendState(update: WhatsAppWebSendStateUpdate) {
  const publication = await prisma.publication.findUnique({
    where: { id: update.publicationId },
    select: { metadata: true },
  });
  if (!publication) throw new Error("PUBLICATION_NOT_FOUND");
  const existingMetadata = record(publication.metadata);
  const deliveryUncertain = Boolean(
    update.deliveryUncertain ||
    (existingMetadata.deliveryUncertain === true &&
      typeof existingMetadata.deliveryConfirmedAt !== "string"),
  );
  await prisma.publication.update({
    where: { id: update.publicationId },
    data: {
      ...(deliveryUncertain
        ? {
            status: "PUBLICATION_FAILED" as const,
            errorMessage: "WHATSAPP_WEB_DELIVERY_UNCERTAIN",
          }
        : {}),
      metadata: {
        ...existingMetadata,
        stage: update.stage,
        rootCause: update.stage,
        sendWasClicked: update.sendWasClicked,
        ...(update.sendClickStartedAt
          ? { sendClickStartedAt: update.sendClickStartedAt }
          : {}),
        ...(update.sendClickedAt
          ? { sendClickedAt: update.sendClickedAt }
          : {}),
        deliveryUncertain,
        retryAuthorized: false,
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
    recordSendState: recordPublicationSendState,
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

  if (command === "preflight") {
    const publicationId = option("--publication-id");
    if (!publicationId) throw new Error("PUBLICATION_ID_REQUIRED");
    const { publication, input } = await publicationInput(publicationId);
    const result = await publisher.preflight(input);
    const current = await prisma.publication.findUnique({
      where: { id: publication.id },
      select: { metadata: true },
    });
    await prisma.publication.update({
      where: { id: publication.id },
      data: {
        metadata: {
          ...record(current?.metadata),
          lastPreflight: result,
          lastPreflightAt: new Date().toISOString(),
        } as Prisma.InputJsonValue,
      },
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  if (command === "inspect-draft") {
    const publicationId = option("--publication-id");
    if (!publicationId) throw new Error("PUBLICATION_ID_REQUIRED");
    const holdMs = inspectionHoldMs(20_000);
    const devtools =
      process.argv.includes("--devtools") ||
      process.env.WHATSAPP_WEB_DEVTOOLS === "true";
    const { publication, input } = await publicationInput(publicationId);
    const result = await publisher.inspectDraft(input, {
      holdMs,
      confirmVisualDraft: () => askVisualDraftConfirmation(holdMs),
      ...(devtools ? { devtools: true } : {}),
    });
    const current = await prisma.publication.findUnique({
      where: { id: publication.id },
      select: { metadata: true },
    });
    await prisma.publication.update({
      where: { id: publication.id },
      data: {
        metadata: {
          ...record(current?.metadata),
          lastVisualDraftInspectionAt: new Date().toISOString(),
          lastVisualDraftInspectionFingerprint:
            result.visualDraftInspectionFingerprint,
          visualDraftInspectionConfirmed:
            result.status === "AWAITING_VISUAL_INSPECTION_COMPLETED" &&
            result.visualDraftInspectionConfirmed,
          lastVisualDraftInspection: {
            status: result.status,
            stage: result.stage,
            captionVisibleTextConfirmed: result.captionVisibleTextConfirmed,
            captionOverlayScoped: result.captionOverlayScoped,
            captionTopmostConfirmed: result.captionTopmostConfirmed,
            captionActiveElementConfirmed: result.captionActiveElementConfirmed,
            captionExactSnapshotConfirmed: result.captionExactSnapshotConfirmed,
            affiliateUrlOccurrenceCount: result.affiliateUrlOccurrenceCount,
            sendTriggerTrialSucceeded: result.sendTriggerTrialSucceeded,
            sendCalled: false,
            draftCleared: result.draftCleared,
          },
        } as Prisma.InputJsonValue,
      },
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  if (command === "inspect-layout") {
    const publicationId = option("--publication-id");
    if (!publicationId) throw new Error("PUBLICATION_ID_REQUIRED");
    const holdMs = inspectionHoldMs(30_000);
    const devtools =
      process.argv.includes("--devtools") ||
      process.env.WHATSAPP_WEB_DEVTOOLS === "true";
    const { publication, input } = await publicationInput(publicationId);
    const result = await publisher.inspectLayout(input, {
      holdMs,
      ...(devtools ? { devtools: true } : {}),
    });
    const current = await prisma.publication.findUnique({
      where: { id: publication.id },
      select: { metadata: true },
    });
    await prisma.publication.update({
      where: { id: publication.id },
      data: {
        metadata: {
          ...record(current?.metadata),
          lastMediaLayoutInspectionAt: new Date().toISOString(),
          lastMediaLayoutInspection: result,
        } as Prisma.InputJsonValue,
      },
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  if (command === "config-check") {
    const publicationId = option("--publication-id");
    if (!publicationId) throw new Error("PUBLICATION_ID_REQUIRED");
    const { input } = await publicationInput(publicationId);
    const result = validateRealSendEligibility({
      config: runtimeConfig,
      channel: input.channel,
      publication: {
        status: input.publicationStatus ?? "SCHEDULED",
        metadata: input.publicationMetadata,
        messageSnapshot: input.message,
        imageSnapshot: input.imageUrl,
      },
      confirmSend: true,
    });
    process.stdout.write(
      `${JSON.stringify({ ...result, browserOpened: false })}\n`,
    );
    return;
  }

  if (command === "publish") {
    const publicationId = option("--publication-id");
    if (!publicationId) throw new Error("PUBLICATION_ID_REQUIRED");
    const { publication, input } = await publicationInput(publicationId);
    const confirmSend = process.argv.includes("--confirm-send");
    const eligibility = validateRealSendEligibility({
      config: runtimeConfig,
      channel: input.channel,
      publication: {
        status: publication.status,
        metadata: publication.metadata,
        messageSnapshot: input.message,
        imageSnapshot: input.imageUrl,
      },
      confirmSend,
    });
    if (!eligibility.realSendEligible) {
      process.stdout.write(
        `${JSON.stringify({
          status: "FAILED",
          errorCode: eligibility.blockingReason,
          browserOpened: false,
          mediaPrepared: false,
          draftCreated: false,
          sendCalled: false,
        })}\n`,
      );
      return;
    }
    const result = await publisher.publish({
      ...input,
      confirmSend,
    });
    const uncertain = result.status === "DELIVERY_UNCERTAIN";
    const attemptNumber = await prisma.publicationAttempt.count({
      where: { publicationId: publication.id },
    });
    await prisma.publicationAttempt.create({
      data: {
        publicationId: publication.id,
        attemptNumber: attemptNumber + 1,
        status: result.status === "PUBLISHED" ? "SUCCESS" : "FAILED",
        requestPayload: {
          publicationId: publication.id,
          channelId: publication.channelId,
          publicationMode: "WEB_EXPERIMENTAL",
        },
        responsePayload: {
          status: result.status,
          errorCode: result.errorCode ?? null,
          stage: result.stage,
          sendWasClicked: result.sendWasClicked,
          sendClickStartedAt: result.sendClickStartedAt ?? null,
          sendClickedAt: result.sendClickedAt ?? null,
          deliveryUncertain: result.deliveryUncertain,
        },
        errorMessage: result.errorCode ?? null,
      },
    });
    const current = await prisma.publication.findUnique({
      where: { id: publication.id },
      select: { metadata: true },
    });
    const currentMetadata = record(current?.metadata);
    const deliveryUncertain = Boolean(
      result.status !== "PUBLISHED" &&
      (uncertain ||
        (currentMetadata.deliveryUncertain === true &&
          typeof currentMetadata.deliveryConfirmedAt !== "string")),
    );
    await prisma.publication.update({
      where: { id: publication.id },
      data: {
        status:
          result.status === "PUBLISHED" ? "PUBLISHED" : "PUBLICATION_FAILED",
        publishedAt: result.status === "PUBLISHED" ? new Date() : null,
        errorMessage: deliveryUncertain
          ? "WHATSAPP_WEB_DELIVERY_UNCERTAIN"
          : (result.errorCode ?? null),
        metadata: {
          ...currentMetadata,
          ...result.metadata,
          rootCause: result.rootCause,
          stage: result.stage,
          retryAuthorized: false,
          deliveryUncertain,
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

  throw new Error(
    "USAGE: login|health|diagnose|locate|dry-run|preflight|inspect-layout|inspect-draft|config-check|publish",
  );
}

main()
  .catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "WHATSAPP_WEB_UNEXPECTED_STATE"}\n`,
    );
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
