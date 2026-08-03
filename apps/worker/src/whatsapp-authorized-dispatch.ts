import {
  claimWhatsAppWebSendAuthorization,
  finalizeWhatsAppWebDispatch,
  prisma,
  Prisma,
  recordWhatsAppWebDispatchSendState,
  whatsappWebPublicationFingerprint,
} from "@affiliate/database";
import {
  getWhatsAppWebRuntimeConfig,
  RedisWhatsAppWebProfileLock,
  WhatsAppGroupsWebPublisher,
  validateRealSendEligibility,
  type WhatsAppGroupsWebPublisherContract,
  type WhatsAppWebChannelConfiguration,
  type WhatsAppWebPublicationInput,
  type WhatsAppWebRuntimeConfig,
  type WhatsAppWebSendStateUpdate,
} from "@affiliate/publisher-connectors";
import { acquireLock, type LockHandle } from "@affiliate/redis";

const ACTOR = "LOCAL_REPOSITORY_OWNER_CLI";

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

export type AuthorizedDispatchContext = {
  publication: {
    id: string;
    offerId: string;
    channelId: string;
    status: string;
    metadata: unknown;
  };
  input: WhatsAppWebPublicationInput;
  fingerprint: string;
};

export type AuthorizedDispatchResult = {
  status: "PUBLISHED" | "DELIVERY_UNCERTAIN" | "FAILED" | "SKIPPED";
  errorCode: string | null;
  publicationId: string;
  channelId: string | null;
  authorizationClaimed: boolean;
  authorizationConsumed: boolean;
  claimId: string | null;
  browserOpened: boolean;
  sendCalled: boolean;
};

export type AuthorizedDispatchDependencies = {
  config: WhatsAppWebRuntimeConfig;
  loadContext(publicationId: string): Promise<AuthorizedDispatchContext>;
  acquireOperationalLock(channelId: string, ttlMs: number): Promise<LockHandle>;
  claim(publicationId: string): Promise<{
    claimId: string;
    channelId: string;
  }>;
  acquireProfileLock(profileKey: string, ttlMs: number): Promise<LockHandle>;
  acquirePublicationLock(publicationId: string, ttlMs: number): Promise<LockHandle>;
  createPublisher(
    profileLock: LockHandle,
    recordSendState: (update: WhatsAppWebSendStateUpdate) => Promise<void>,
  ): WhatsAppGroupsWebPublisherContract;
  createAttempt(context: AuthorizedDispatchContext, claimId: string): Promise<string>;
  finishAttempt(
    attemptId: string,
    result: {
      status: "SUCCESS" | "FAILED";
      errorCode: string | null;
      stage: string | null;
      sendWasClicked: boolean;
      deliveryUncertain: boolean;
    },
  ): Promise<void>;
  recordSendState(
    update: WhatsAppWebSendStateUpdate,
    claimId: string,
  ): Promise<void>;
  finalize(input: {
    publicationId: string;
    claimId: string;
    outcome: "PUBLISHED" | "DELIVERY_UNCERTAIN" | "FAILED_BEFORE_CLICK";
    errorCode: string | null;
    resultMetadata: Record<string, unknown>;
  }): Promise<void>;
  emit(event: Record<string, unknown>): void;
};

function safeError(error: unknown) {
  return error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
    ? error.message
    : "WHATSAPP_WEB_DISPATCH_UNEXPECTED_FAILURE";
}

function rejected(
  publicationId: string,
  channelId: string | null,
  errorCode: string,
): AuthorizedDispatchResult {
  return {
    status: errorCode === "WHATSAPP_WEB_PUBLICATION_ALREADY_PUBLISHED" ? "SKIPPED" : "FAILED",
    errorCode,
    publicationId,
    channelId,
    authorizationClaimed: false,
    authorizationConsumed: false,
    claimId: null,
    browserOpened: false,
    sendCalled: false,
  };
}

function assertPersistedDispatchGates(context: AuthorizedDispatchContext) {
  const metadata = record(context.publication.metadata);
  if (metadata.whatsappWebState !== "AUTHORIZED_FOR_SEND") {
    throw new Error("WHATSAPP_WEB_SEND_AUTHORIZATION_REQUIRED");
  }
  if (metadata.sendAuthorizationStatus === "REVOKED") {
    throw new Error("WHATSAPP_WEB_SEND_AUTHORIZATION_REVOKED");
  }
  if (metadata.sendAuthorizationStatus === "CLAIMED" || metadata.sendAuthorizationStatus === "CONSUMED") {
    throw new Error("WHATSAPP_WEB_SEND_AUTHORIZATION_ALREADY_CONSUMED");
  }
  if (metadata.sendAuthorizationStatus !== "ACTIVE") {
    throw new Error("WHATSAPP_WEB_SEND_AUTHORIZATION_REQUIRED");
  }
  if (!text(metadata.sendAuthorizationId)) {
    throw new Error("WHATSAPP_WEB_SEND_AUTHORIZATION_REQUIRED");
  }
  const expiresAt = new Date(text(metadata.sendAuthorizationExpiresAt));
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
    throw new Error("WHATSAPP_WEB_SEND_AUTHORIZATION_EXPIRED");
  }
  if (
    metadata.sendAuthorizationPublicationId !== context.publication.id ||
    metadata.sendAuthorizationChannelId !== context.publication.channelId
  ) {
    throw new Error("WHATSAPP_WEB_SEND_AUTHORIZATION_BINDING_MISMATCH");
  }
  if (
    metadata.preflightCompleted !== true ||
    metadata.preflightFingerprint !== context.fingerprint
  ) {
    throw new Error("WHATSAPP_WEB_PREFLIGHT_REQUIRED");
  }
  if (metadata.sendAuthorizationFingerprint !== context.fingerprint) {
    throw new Error("WHATSAPP_WEB_SEND_AUTHORIZATION_FINGERPRINT_MISMATCH");
  }
}

async function release(handle: LockHandle | null) {
  await handle?.release().catch(() => undefined);
}

export async function dispatchAuthorizedWhatsAppPublication(
  input: { publicationId: string; confirmSend: boolean },
  dependencies: AuthorizedDispatchDependencies = createAuthorizedDispatchDependencies(),
): Promise<AuthorizedDispatchResult> {
  const startedAt = Date.now();
  let context: AuthorizedDispatchContext;
  dependencies.emit({
    event: "DISPATCH_REQUESTED",
    publicationId: input.publicationId,
    browserOpened: false,
    sendCalled: false,
  });
  try {
    context = await dependencies.loadContext(input.publicationId);
  } catch (error) {
    const errorCode = safeError(error);
    dependencies.emit({ event: "DISPATCH_GATE_REJECTED", publicationId: input.publicationId, errorCode });
    return rejected(input.publicationId, null, errorCode);
  }

  if (context.publication.status === "PUBLISHED") {
    return rejected(
      context.publication.id,
      context.publication.channelId,
      "WHATSAPP_WEB_PUBLICATION_ALREADY_PUBLISHED",
    );
  }

  const eligibility = validateRealSendEligibility({
    config: dependencies.config,
    channel: context.input.channel,
    publication: {
      status: context.publication.status,
      metadata: context.publication.metadata,
      messageSnapshot: context.input.message,
      imageSnapshot: context.input.imageUrl,
    },
    confirmSend: input.confirmSend,
  });
  if (!eligibility.realSendEligible) {
    const result = rejected(
      context.publication.id,
      context.publication.channelId,
      eligibility.blockingReason ?? "WHATSAPP_WEB_PUBLICATION_INELIGIBLE",
    );
    dependencies.emit({
      event: "DISPATCH_GATE_REJECTED",
      publicationId: context.publication.id,
      channelId: context.publication.channelId,
      errorCode: result.errorCode,
      browserOpened: false,
      sendCalled: false,
    });
    return result;
  }
  try {
    assertPersistedDispatchGates(context);
  } catch (error) {
    const errorCode = safeError(error);
    dependencies.emit({ event: "DISPATCH_GATE_REJECTED", publicationId: context.publication.id, channelId: context.publication.channelId, errorCode });
    return rejected(context.publication.id, context.publication.channelId, errorCode);
  }

  let operationalLock: LockHandle | null = null;
  let profileLock: LockHandle | null = null;
  let publicationLock: LockHandle | null = null;
  let claimId: string | null = null;
  let attemptId: string | null = null;
  let browserOpened = false;
  let sendCalled = false;
  let sendClickStarted = false;
  try {
    operationalLock = await dependencies.acquireOperationalLock(
      context.publication.channelId,
      dependencies.config.profileLockTtlMs,
    );
    if (!operationalLock.acquired) {
      throw new Error(
        operationalLock.failureReason === "REDIS_UNAVAILABLE"
          ? "REDIS_UNAVAILABLE"
          : "WHATSAPP_WEB_CHANNEL_DISPATCH_IN_PROGRESS",
      );
    }
    const claim = await dependencies.claim(context.publication.id);
    claimId = claim.claimId;
    dependencies.emit({
      event: "AUTHORIZATION_CLAIMED",
      publicationId: context.publication.id,
      channelId: context.publication.channelId,
      claimId: claimId.slice(0, 12),
      fingerprint: context.fingerprint.slice(0, 12),
    });

    profileLock = await dependencies.acquireProfileLock(
      context.input.channel.webProfileKey,
      dependencies.config.profileLockTtlMs,
    );
    if (!profileLock.acquired) {
      throw new Error(
        profileLock.failureReason === "REDIS_UNAVAILABLE"
          ? "REDIS_UNAVAILABLE"
          : "WHATSAPP_WEB_PROFILE_IN_USE",
      );
    }
    publicationLock = await dependencies.acquirePublicationLock(
      context.publication.id,
      dependencies.config.profileLockTtlMs,
    );
    if (!publicationLock.acquired) {
      throw new Error("WHATSAPP_WEB_PUBLICATION_DISPATCH_IN_PROGRESS");
    }
    const renewal = setInterval(() => {
      void operationalLock?.extend(dependencies.config.profileLockTtlMs);
      void publicationLock?.extend(dependencies.config.profileLockTtlMs);
    }, Math.max(1_000, Math.floor(dependencies.config.profileLockTtlMs / 3)));
    renewal.unref?.();
    try {
      attemptId = await dependencies.createAttempt(context, claimId);
      const publisher = dependencies.createPublisher(
        profileLock,
        async (update) => {
          await dependencies.recordSendState(update, claimId!);
          sendClickStarted ||= Boolean(update.sendClickStartedAt);
          sendCalled ||= update.sendWasClicked;
          dependencies.emit({
            event:
              update.stage === "SEND_CLICK_STARTED"
                ? "SEND_CLICK_STARTED"
                : update.stage === "SEND_CLICK_COMPLETED"
                  ? "SEND_CLICK_COMPLETED"
                  : update.stage === "DELIVERY_CONFIRMED"
                    ? "DELIVERY_CONFIRMED"
                    : "DRAFT_PREPARED",
            publicationId: update.publicationId,
            channelId: context.publication.channelId,
            attemptId,
            stage: update.stage,
            browserOpened: true,
            sendCalled: update.sendWasClicked,
          });
        },
      );
      browserOpened = true;
      dependencies.emit({
        event: "BROWSER_START_REQUESTED",
        publicationId: context.publication.id,
        channelId: context.publication.channelId,
        attemptId,
        browserOpened: false,
        sendCalled: false,
      });
      const result = await publisher.publish({
        ...context.input,
        confirmSend: true,
      });
      sendCalled ||= result.sendWasClicked;
      const failedBeforeClick =
        !result.sendWasClicked &&
        (result.status === "FAILED" ||
          result.errorCode === "WHATSAPP_WEB_SEND_STATE_PERSIST_FAILED");
      const outcome =
        result.status === "PUBLISHED"
          ? "PUBLISHED"
          : failedBeforeClick
            ? "FAILED_BEFORE_CLICK"
            : "DELIVERY_UNCERTAIN";
      await dependencies.finalize({
        publicationId: context.publication.id,
        claimId,
        outcome,
        errorCode: result.errorCode ?? null,
        resultMetadata: record(result.metadata),
      });
      await dependencies.finishAttempt(attemptId, {
        status: result.status === "PUBLISHED" ? "SUCCESS" : "FAILED",
        errorCode: result.errorCode ?? null,
        stage: result.stage ?? null,
        sendWasClicked: result.sendWasClicked,
        deliveryUncertain: outcome === "DELIVERY_UNCERTAIN",
      });
      const finalResult: AuthorizedDispatchResult = {
        status:
          outcome === "PUBLISHED"
            ? "PUBLISHED"
            : outcome === "DELIVERY_UNCERTAIN"
              ? "DELIVERY_UNCERTAIN"
              : "FAILED",
        errorCode: result.errorCode ?? null,
        publicationId: context.publication.id,
        channelId: context.publication.channelId,
        authorizationClaimed: true,
        authorizationConsumed: outcome !== "FAILED_BEFORE_CLICK",
        claimId: claimId.slice(0, 12),
        browserOpened,
        sendCalled,
      };
      if (outcome !== "PUBLISHED") {
        dependencies.emit({
          event:
            outcome === "DELIVERY_UNCERTAIN"
              ? "DELIVERY_UNCERTAIN"
              : "DISPATCH_FAILED_BEFORE_CLICK",
          publicationId: context.publication.id,
          channelId: context.publication.channelId,
          attemptId,
          errorCode: finalResult.errorCode,
          browserOpened,
          sendCalled,
        });
      }
      dependencies.emit({
        event: "DISPATCH_FINISHED",
        publicationId: context.publication.id,
        channelId: context.publication.channelId,
        attemptId,
        errorCode: finalResult.errorCode,
        durationMs: Date.now() - startedAt,
        browserOpened,
        sendCalled,
      });
      return finalResult;
    } finally {
      clearInterval(renewal);
    }
  } catch (error) {
    const errorCode = safeError(error);
    if (claimId) {
      const outcome = sendClickStarted
        ? "DELIVERY_UNCERTAIN"
        : "FAILED_BEFORE_CLICK";
      await dependencies
        .finalize({
          publicationId: context.publication.id,
          claimId,
          outcome,
          errorCode,
          resultMetadata: {},
        })
        .catch(() => undefined);
      if (attemptId) {
        await dependencies
          .finishAttempt(attemptId, {
            status: "FAILED",
            errorCode,
            stage: null,
            sendWasClicked: sendCalled,
            deliveryUncertain: sendClickStarted,
          })
          .catch(() => undefined);
      }
    }
    dependencies.emit({
      event: claimId
        ? sendClickStarted
          ? "DELIVERY_UNCERTAIN"
          : "DISPATCH_FAILED_BEFORE_CLICK"
        : "DISPATCH_GATE_REJECTED",
      publicationId: context.publication.id,
      channelId: context.publication.channelId,
      attemptId,
      errorCode,
      durationMs: Date.now() - startedAt,
      browserOpened,
      sendCalled,
    });
    dependencies.emit({
      event: "DISPATCH_FINISHED",
      publicationId: context.publication.id,
      channelId: context.publication.channelId,
      attemptId,
      errorCode,
      durationMs: Date.now() - startedAt,
      browserOpened,
      sendCalled,
    });
    return {
      status: sendClickStarted ? "DELIVERY_UNCERTAIN" : "FAILED",
      errorCode,
      publicationId: context.publication.id,
      channelId: context.publication.channelId,
      authorizationClaimed: Boolean(claimId),
      authorizationConsumed: Boolean(claimId && sendClickStarted),
      claimId: claimId?.slice(0, 12) ?? null,
      browserOpened,
      sendCalled,
    };
  } finally {
    await release(publicationLock);
    await release(profileLock);
    await release(operationalLock);
  }
}

export function createAuthorizedDispatchDependencies(): AuthorizedDispatchDependencies {
  const config = getWhatsAppWebRuntimeConfig();
  return {
    config,
    async loadContext(publicationId) {
      const publication = await prisma.publication.findUnique({
        where: { id: publicationId },
        include: { channel: true },
      });
      if (!publication) throw new Error("PUBLICATION_NOT_FOUND");
      const payload = record(publication.messagePayload);
      const message = text(payload.message);
      const affiliateUrl = publication.affiliateUrlSnapshot || "";
      if (!message || !affiliateUrl) throw new Error("PUBLICATION_SNAPSHOT_INVALID");
      const input: WhatsAppWebPublicationInput = {
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
      };
      return {
        publication,
        input,
        fingerprint: whatsappWebPublicationFingerprint({
          publication,
          channel: publication.channel,
        }),
      };
    },
    acquireOperationalLock: (channelId, ttlMs) =>
      acquireLock(`whatsapp-web:dispatch-channel:${channelId}`, ttlMs, {
        requireRedis: true,
      }),
    claim: (publicationId) =>
      claimWhatsAppWebSendAuthorization(prisma, {
        publicationId,
        actorId: ACTOR,
      }),
    acquireProfileLock: (profileKey, ttlMs) =>
      new RedisWhatsAppWebProfileLock().acquire(profileKey, ttlMs),
    acquirePublicationLock: (publicationId, ttlMs) =>
      acquireLock(`whatsapp-web:dispatch-publication:${publicationId}`, ttlMs, {
        requireRedis: true,
      }),
    createPublisher(profileLock, recordSendState) {
      let delegated = false;
      return new WhatsAppGroupsWebPublisher({
        config,
        profileLock: {
          acquire: async () => {
            if (delegated) throw new Error("WHATSAPP_WEB_PROFILE_IN_USE");
            delegated = true;
            return profileLock;
          },
        },
        recordSendState,
      });
    },
    async createAttempt(context, claimId) {
      const attemptNumber =
        (await prisma.publicationAttempt.count({
          where: { publicationId: context.publication.id },
        })) + 1;
      const attempt = await prisma.publicationAttempt.create({
        data: {
          publicationId: context.publication.id,
          attemptNumber,
          status: "PENDING",
          requestPayload: {
            publicationId: context.publication.id,
            channelId: context.publication.channelId,
            publicationMode: "WEB_EXPERIMENTAL",
            claimId: claimId.slice(0, 12),
          },
        },
      });
      return attempt.id;
    },
    finishAttempt: async (attemptId, result) => {
      await prisma.publicationAttempt.update({
        where: { id: attemptId },
        data: {
          status: result.status,
          errorMessage: result.errorCode,
          responsePayload: result as Prisma.InputJsonValue,
        },
      });
    },
    recordSendState: (update, claimId) =>
      recordWhatsAppWebDispatchSendState(prisma, { ...update, claimId }).then(
        () => undefined,
      ),
    finalize: (input) =>
      finalizeWhatsAppWebDispatch(prisma, {
        ...input,
        actorId: ACTOR,
        autoPauseAfterSuccess: config.autoPauseAfterFirstSuccess,
      }).then(() => undefined),
    emit(event) {
      process.stderr.write(`${JSON.stringify(event)}\n`);
    },
  };
}
