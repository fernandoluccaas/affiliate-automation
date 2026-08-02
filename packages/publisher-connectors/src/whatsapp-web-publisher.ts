import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { prepareRemoteImage } from "./media";
import {
  getWhatsAppWebRuntimeConfig,
  PlaywrightWhatsAppWebBrowserLauncher,
  RedisWhatsAppWebProfileLock,
  resolveWhatsAppWebProfilePath,
  sanitizeWhatsAppWebProfileKey,
  WhatsAppWebSessionManager,
  type WhatsAppWebRuntimeConfig,
} from "./whatsapp-web-session";
import type {
  BrowserSession,
  WhatsAppGroupLocationResult,
  WhatsAppWebBrowserLauncher,
  WhatsAppWebHealthResult,
  WhatsAppWebErrorCode,
  WhatsAppWebPageAdapter,
  WhatsAppWebProfileLock,
  WhatsAppWebSafeDiagnostics,
  WhatsAppWebDiagnosticStage,
  WhatsAppWebSendTriggerInspection,
  WhatsAppWebStructureDiagnosticResult,
} from "./whatsapp-web-types";
import { WhatsAppWebStageError } from "./whatsapp-web-types";

export type WhatsAppWebChannelConfiguration = {
  channelId: string;
  channelType: string;
  channelEnabled: boolean;
  channelPaused: boolean;
  publicationMode: string;
  groupDisplayName: string;
  webProfileKey: string;
  webAutomationEnabled: boolean;
  webAutomationOwnershipConfirmed: boolean;
  webAutomationConfirmedAt?: string | null;
  sendImage: boolean;
  lastSuccessfulDryRunAt?: string | null;
  lastSuccessfulDryRunConfigurationFingerprint?: string | null;
};

export type WhatsAppWebPublicationInput = {
  publicationId: string;
  offerId: string;
  destinationType: "GROUP";
  message: string;
  affiliateUrl: string;
  title: string;
  currentPrice?: string;
  imageUrl?: string | null;
  channel: WhatsAppWebChannelConfiguration;
};

export type WhatsAppWebDryRunResult = {
  status: "READY_TO_SEND" | "FAILED";
  dryRun: true;
  dryRunAt: string;
  groupExactMatch: boolean;
  affiliateUrlConfirmedInDraft: boolean;
  mediaPrepared: boolean;
  mediaFallbackUsed: boolean;
  draftCleared: boolean;
  sendCalled: false;
  configurationFingerprint: string;
  errorCode?: string;
  stage?: import("./whatsapp-web-types").WhatsAppWebDiagnosticStage;
  diagnostics?: WhatsAppWebSafeDiagnostics;
};

export type WhatsAppWebPublishResult = {
  status: "PUBLISHED" | "FAILED" | "DELIVERY_UNCERTAIN" | "SKIPPED";
  publicationMode: "WEB_EXPERIMENTAL";
  destinationType: "GROUP";
  sendWasClicked: boolean;
  sendClickStartedAt?: string;
  sendClickedAt?: string;
  deliveryConfirmed: boolean;
  deliveryUncertain: boolean;
  stage: WhatsAppWebDiagnosticStage;
  rootCause: WhatsAppWebDiagnosticStage;
  mediaFallbackUsed: boolean;
  errorCode?: string;
  metadata: Record<string, unknown>;
};

export type WhatsAppWebPreflightResult = {
  status: "READY_TO_COMMIT_SEND" | "FAILED";
  groupExactMatch: boolean;
  mediaPrepared: boolean;
  affiliateUrlConfirmedInDraft: boolean;
  sendTriggerFound: boolean;
  sendTriggerVisible: boolean;
  sendTriggerEnabled: boolean;
  sendCalled: false;
  draftCleared: boolean;
  stage: WhatsAppWebDiagnosticStage;
  errorCode?: string;
  diagnostics: WhatsAppWebSafeDiagnostics;
};

export type WhatsAppWebSendStateUpdate = {
  publicationId: string;
  stage: WhatsAppWebDiagnosticStage;
  sendWasClicked: boolean;
  sendClickStartedAt?: string;
  sendClickedAt?: string;
  deliveryUncertain: boolean;
};

export interface WhatsAppGroupsWebPublisherContract {
  healthCheck(input: { profileKey: string }): Promise<WhatsAppWebHealthResult>;
  diagnose(input: {
    profileKey: string;
  }): Promise<WhatsAppWebStructureDiagnosticResult>;
  locateGroup(input: {
    profileKey: string;
    groupDisplayName: string;
  }): Promise<WhatsAppGroupLocationResult>;
  dryRun(input: WhatsAppWebPublicationInput): Promise<WhatsAppWebDryRunResult>;
  preflight(
    input: WhatsAppWebPublicationInput,
  ): Promise<WhatsAppWebPreflightResult>;
  publish(
    input: WhatsAppWebPublicationInput,
  ): Promise<WhatsAppWebPublishResult>;
}

export function whatsappWebConfigurationFingerprint(
  channel: WhatsAppWebChannelConfiguration,
) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        channelId: channel.channelId,
        groupDisplayName: channel.groupDisplayName.replace(/\s+/g, " ").trim(),
        profileKey: sanitizeWhatsAppWebProfileKey(channel.webProfileKey),
        mode: channel.publicationMode,
        sendImage: channel.sendImage,
      }),
    )
    .digest("hex");
}

export function validateWhatsAppWebPublication(
  input: WhatsAppWebPublicationInput,
) {
  if (
    input.destinationType !== "GROUP" ||
    input.channel.channelType !== "WHATSAPP_GROUPS"
  ) {
    throw new Error("WHATSAPP_WEB_UNEXPECTED_STATE");
  }
  if (input.channel.publicationMode !== "WEB_EXPERIMENTAL") {
    throw new Error("WHATSAPP_WEB_DISABLED");
  }
  if (
    !input.title.trim() ||
    !input.message.includes(input.title.trim()) ||
    /<[^>]+>/.test(input.message) ||
    /#publi\b/i.test(input.message)
  ) {
    throw new Error("WHATSAPP_WEB_DRAFT_VALIDATION_FAILED");
  }
  const parsed = new URL(input.affiliateUrl);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error("WHATSAPP_WEB_DRAFT_VALIDATION_FAILED");
  }
  if (input.message.split(input.affiliateUrl).length - 1 !== 1) {
    throw new Error("WHATSAPP_WEB_DRAFT_VALIDATION_FAILED");
  }
  if (input.currentPrice) {
    const expectedPrice = new Intl.NumberFormat("pt-BR", {
      style: "currency",
      currency: "BRL",
    }).format(Number(input.currentPrice));
    if (!input.message.includes(expectedPrice)) {
      throw new Error("WHATSAPP_WEB_DRAFT_VALIDATION_FAILED");
    }
  }
}

export class WhatsAppGroupsWebPublisher implements WhatsAppGroupsWebPublisherContract {
  constructor(
    private readonly dependencies: {
      config?: WhatsAppWebRuntimeConfig;
      launcher?: WhatsAppWebBrowserLauncher;
      profileLock?: WhatsAppWebProfileLock;
      prepareImage?: typeof prepareRemoteImage;
      now?: () => Date;
      profileInitialized?: (path: string) => Promise<boolean>;
      localDiagnosticKeepOpenOnErrorMs?: number;
      writeTempFile?: typeof writeFile;
      statTempFile?: typeof stat;
      recordSendState?: (update: WhatsAppWebSendStateUpdate) => Promise<void>;
    } = {},
  ) {}

  private get config() {
    return this.dependencies.config ?? getWhatsAppWebRuntimeConfig();
  }
  private get launcher() {
    return (
      this.dependencies.launcher ?? new PlaywrightWhatsAppWebBrowserLauncher()
    );
  }
  private get profileLock() {
    return this.dependencies.profileLock ?? new RedisWhatsAppWebProfileLock();
  }
  private now() {
    return this.dependencies.now?.() ?? new Date();
  }

  async healthCheck(input: {
    profileKey: string;
  }): Promise<WhatsAppWebHealthResult> {
    const checkedAt = this.now().toISOString();
    if (!this.config.enabled)
      return {
        status: "DISABLED",
        checkedAt,
        errorCode: "WHATSAPP_WEB_DISABLED",
      };
    const profileKey = sanitizeWhatsAppWebProfileKey(input.profileKey);
    if (!(await this.launcher.isAvailable())) {
      return {
        status: "BROWSER_UNAVAILABLE",
        checkedAt,
        errorCode: "WHATSAPP_WEB_BROWSER_UNAVAILABLE",
      };
    }
    const profilePath = resolveWhatsAppWebProfilePath(
      this.config.userDataRoot,
      profileKey,
    );
    const profileInitialized = this.dependencies.profileInitialized
      ? await this.dependencies.profileInitialized(profilePath)
      : this.dependencies.launcher
        ? true
        : await access(profilePath)
            .then(() => true)
            .catch(() => false);
    if (!profileInitialized) {
      return {
        status: "NOT_INITIALIZED",
        checkedAt,
        errorCode: "WHATSAPP_WEB_PROFILE_NOT_INITIALIZED",
      };
    }
    const lock = await this.profileLock.acquire(
      profileKey,
      this.config.profileLockTtlMs,
    );
    if (!lock.acquired) {
      return lock.failureReason === "REDIS_UNAVAILABLE"
        ? {
            status: "REDIS_UNAVAILABLE",
            checkedAt,
            errorCode: "REDIS_UNAVAILABLE",
          }
        : {
            status: "PROFILE_IN_USE",
            checkedAt,
            errorCode: "WHATSAPP_WEB_PROFILE_IN_USE",
          };
    }
    let session: BrowserSession | null = null;
    try {
      session = await this.openSession(profileKey);
      await session.adapter.navigate();
      const state = await session.adapter.detectAuthenticationState();
      return state === "CONNECTED"
        ? { status: "CONNECTED", checkedAt }
        : state === "LOGIN_REQUIRED"
          ? {
              status: "LOGIN_REQUIRED",
              checkedAt,
              errorCode: "WHATSAPP_WEB_LOGIN_REQUIRED",
            }
          : {
              status: "UNEXPECTED_STATE",
              checkedAt,
              errorCode: "WHATSAPP_WEB_UNEXPECTED_STATE",
            };
    } catch (error) {
      return { status: "ERROR", checkedAt, errorCode: errorCode(error) };
    } finally {
      await session?.close().catch(() => undefined);
      await lock.release().catch(() => undefined);
    }
  }

  async locateGroup(input: { profileKey: string; groupDisplayName: string }) {
    try {
      return await this.withConnectedSession(
        input.profileKey,
        async (adapter) => {
          const located = await adapter.locateGroupExact(
            input.groupDisplayName,
          );
          if (located.status !== "GROUP_FOUND") return located;
          await adapter.openGroup(input.groupDisplayName);
          if (!(await adapter.verifyOpenedGroup(input.groupDisplayName))) {
            return {
              status: "GROUP_NOT_FOUND" as const,
              exactMatch: false,
              publishPermission: false,
              errorCode: "WHATSAPP_WEB_GROUP_NOT_FOUND" as const,
            };
          }
          const permission = await adapter.verifyPublishPermission();
          return permission
            ? {
                ...located,
                status: "GROUP_FOUND" as const,
                exactMatch: true,
                publishPermission: true,
              }
            : {
                ...located,
                status: "NO_PUBLISH_PERMISSION" as const,
                exactMatch: true,
                publishPermission: false,
                errorCode: "WHATSAPP_WEB_NO_PUBLISH_PERMISSION" as const,
              };
        },
        { isFailure: (result) => result.status !== "GROUP_FOUND" },
      );
    } catch (error) {
      const code = errorCode(error);
      if (error instanceof WhatsAppWebStageError) {
        return {
          status: "SELECTOR_MISMATCH" as const,
          exactMatch: false,
          publishPermission: false,
          errorCode: "WHATSAPP_WEB_SELECTOR_MISMATCH" as const,
          stage: error.stage,
          rootCause: error.stage,
          diagnostics: error.diagnostics,
        };
      }
      return code === "WHATSAPP_WEB_LOGIN_REQUIRED"
        ? {
            status: "LOGIN_REQUIRED" as const,
            exactMatch: false,
            publishPermission: false,
            errorCode: code,
          }
        : {
            status: "SELECTOR_MISMATCH" as const,
            exactMatch: false,
            publishPermission: false,
            errorCode: "WHATSAPP_WEB_SELECTOR_MISMATCH" as const,
          };
    }
  }

  async diagnose(input: {
    profileKey: string;
  }): Promise<WhatsAppWebStructureDiagnosticResult> {
    try {
      return await this.withConnectedSession(
        input.profileKey,
        (adapter) => adapter.diagnoseStructure(),
        { isFailure: (result) => result.stage !== "READY_FOR_GROUP_SEARCH" },
      );
    } catch (error) {
      const code = errorCode(error);
      return {
        authentication:
          code === "WHATSAPP_WEB_LOGIN_REQUIRED"
            ? "LOGIN_REQUIRED"
            : "UNEXPECTED_STATE",
        shellRecognized: false,
        searchTriggerFound: false,
        searchInputFound: false,
        stage:
          code === "WHATSAPP_WEB_LOGIN_REQUIRED"
            ? "AUTHENTICATED_SHELL_NOT_RECOGNIZED"
            : "APP_SHELL_NOT_FOUND",
        diagnostics: {
          currentOrigin: "https://web.whatsapp.com",
          interfaceLanguage: "unknown",
          shellRecognized: false,
          strategiesTried: 0,
          visible: false,
          enabled: false,
          errorCode: code,
          rootCause:
            code === "WHATSAPP_WEB_LOGIN_REQUIRED"
              ? "AUTHENTICATED_SHELL_NOT_RECOGNIZED"
              : "APP_SHELL_NOT_FOUND",
        },
      };
    }
  }

  async dryRun(
    input: WhatsAppWebPublicationInput,
  ): Promise<WhatsAppWebDryRunResult> {
    const startedAt = Date.now();
    const fingerprint = whatsappWebConfigurationFingerprint(input.channel);
    const progress = {
      dryRun: true as const,
      dryRunAt: this.now().toISOString(),
      groupExactMatch: false,
      affiliateUrlConfirmedInDraft: false,
      mediaPrepared: false,
      mediaFallbackUsed: false,
      draftCleared: false,
      sendCalled: false as const,
      configurationFingerprint: fingerprint,
    };
    const diagnostics: WhatsAppWebSafeDiagnostics = {
      currentOrigin: "https://web.whatsapp.com",
      usedFileChooser: false,
      usedSetInputFiles: false,
      tempFileExists: false,
      tempFileSize: 0,
      tempFileExtension: "",
      previewDetected: false,
      captionDetected: false,
      draftValidated: false,
      draftCleared: false,
    };
    try {
      this.assertChannelEnabled(input.channel);
      if (!this.config.dryRun) throw new Error("WHATSAPP_WEB_DISABLED");
      validateWhatsAppWebPublication(input);
      return await this.withConnectedSession(
        input.channel.webProfileKey,
        async (adapter) => {
          const location = await this.openExactGroup(
            adapter,
            input.channel.groupDisplayName,
          );
          if (location.status !== "GROUP_FOUND")
            throw new Error(location.errorCode);
          progress.groupExactMatch = true;
          const media = await this.prepareMedia(input, diagnostics);
          progress.mediaFallbackUsed = media.fallback;
          let draftMutationAttempted = false;
          let operationError: unknown;
          let cleanupError: unknown;
          try {
            try {
              draftMutationAttempted = true;
              if (media.path) {
                const attachment = await adapter.attachImage(media.path);
                Object.assign(diagnostics, attachment);
                progress.mediaPrepared = true;
                const caption = await adapter.fillCaption(input.message);
                Object.assign(diagnostics, caption);
              } else {
                await adapter.fillText(input.message);
              }
              const inspection = await adapter.inspectPreparedDraft({
                affiliateUrl: input.affiliateUrl,
                textSnippet: uniqueSnippet(input.title),
                expectedText: input.message,
                mediaExpected: Boolean(media.path),
              });
              if (
                !inspection.affiliateUrlFound ||
                !inspection.textSnippetFound ||
                !inspection.mediaFound
              ) {
                throw new WhatsAppWebStageError(
                  "DRAFT_VALIDATION_FAILED",
                  {
                    ...diagnostics,
                    draftValidated: false,
                    rootCause: "DRAFT_VALIDATION_FAILED",
                    errorCode: "WHATSAPP_WEB_DRAFT_VALIDATION_FAILED",
                  },
                  "WHATSAPP_WEB_DRAFT_VALIDATION_FAILED",
                );
              }
              diagnostics.draftValidated = true;
              progress.affiliateUrlConfirmedInDraft = true;
              await this.captureDebugDraft(adapter, "dry-run-ready");
            } catch (error) {
              operationError = error;
            }

            if (draftMutationAttempted) {
              try {
                Object.assign(diagnostics, await adapter.clearDraft());
                progress.draftCleared = await adapter.isDraftClear();
                diagnostics.draftCleared = progress.draftCleared;
                if (!progress.draftCleared) {
                  throw new Error("draft remained visible");
                }
              } catch {
                cleanupError = new WhatsAppWebStageError(
                  "DRAFT_CLEANUP_FAILED",
                  {
                    ...diagnostics,
                    draftCleared: false,
                    rootCause: "DRAFT_CLEANUP_FAILED",
                    errorCode: "WHATSAPP_WEB_DRAFT_CLEANUP_FAILED",
                  },
                  "WHATSAPP_WEB_DRAFT_CLEANUP_FAILED",
                );
              }
            }
          } finally {
            await media.cleanup();
          }
          if (cleanupError) throw cleanupError;
          if (operationError) throw operationError;
          return {
            ...progress,
            status: "READY_TO_SEND",
            stage: "DRY_RUN_READY",
            diagnostics: {
              ...diagnostics,
              durationMs: Date.now() - startedAt,
            },
          };
        },
      );
    } catch (error) {
      if (error instanceof WhatsAppWebStageError) {
        return {
          ...progress,
          status: "FAILED",
          errorCode: error.errorCode,
          stage: error.stage,
          diagnostics: {
            ...diagnostics,
            ...error.diagnostics,
            durationMs: Date.now() - startedAt,
          },
        };
      }
      return {
        ...progress,
        status: "FAILED",
        errorCode: errorCode(error),
        diagnostics: {
          ...diagnostics,
          durationMs: Date.now() - startedAt,
        },
      };
    }
  }

  async preflight(
    input: WhatsAppWebPublicationInput,
  ): Promise<WhatsAppWebPreflightResult> {
    const startedAt = Date.now();
    const progress = {
      groupExactMatch: false,
      mediaPrepared: false,
      affiliateUrlConfirmedInDraft: false,
      sendTriggerFound: false,
      sendTriggerVisible: false,
      sendTriggerEnabled: false,
      sendCalled: false as const,
      draftCleared: false,
    };
    const diagnostics: WhatsAppWebSafeDiagnostics = {
      currentOrigin: "https://web.whatsapp.com",
      strategiesTried: 0,
      candidateCount: 0,
      visible: false,
      enabled: false,
      draftValidated: false,
      draftCleared: false,
    };
    let stage: WhatsAppWebDiagnosticStage = "PRE_SEND_VALIDATION_STARTED";
    try {
      this.assertChannelEnabled(input.channel);
      if (!this.config.dryRun) throw new Error("WHATSAPP_WEB_DISABLED");
      validateWhatsAppWebPublication(input);
      return await this.withConnectedSession(
        input.channel.webProfileKey,
        async (adapter) => {
          const location = await this.openExactGroup(
            adapter,
            input.channel.groupDisplayName,
          );
          if (location.status !== "GROUP_FOUND")
            throw new Error(location.errorCode);
          progress.groupExactMatch = true;
          const media = await this.prepareMedia(input, diagnostics);
          let operationError: unknown;
          let cleanupError: unknown;
          try {
            try {
              await this.prepareDraft(adapter, input, media.path);
              progress.mediaPrepared = Boolean(media.path) || media.fallback;
              const trigger = await this.validatePreSend(
                adapter,
                input,
                Boolean(media.path),
                diagnostics,
              );
              stage = "READY_TO_COMMIT_SEND";
              progress.affiliateUrlConfirmedInDraft = true;
              progress.sendTriggerFound = trigger.found;
              progress.sendTriggerVisible = trigger.visible;
              progress.sendTriggerEnabled = trigger.enabled;
            } catch (error) {
              operationError = error;
            }
            try {
              Object.assign(diagnostics, await adapter.clearDraft());
              progress.draftCleared = await adapter.isDraftClear();
              diagnostics.draftCleared = progress.draftCleared;
              if (!progress.draftCleared) {
                throw new WhatsAppWebStageError(
                  "DRAFT_CLEANUP_FAILED",
                  diagnostics,
                  "WHATSAPP_WEB_DRAFT_CLEANUP_FAILED",
                );
              }
            } catch (error) {
              cleanupError = error;
            }
          } finally {
            await media.cleanup().catch(() => undefined);
          }
          if (operationError) throw operationError;
          if (cleanupError) throw cleanupError;
          return {
            ...progress,
            status: "READY_TO_COMMIT_SEND" as const,
            stage,
            diagnostics: {
              ...diagnostics,
              durationMs: Date.now() - startedAt,
            },
          };
        },
      );
    } catch (error) {
      const stageValue =
        error instanceof WhatsAppWebStageError ? error.stage : stage;
      return {
        ...progress,
        status: "FAILED",
        stage: stageValue,
        errorCode: errorCode(error),
        diagnostics: {
          ...diagnostics,
          ...(error instanceof WhatsAppWebStageError ? error.diagnostics : {}),
          rootCause: stageValue,
          errorCode: errorCode(error),
          durationMs: Date.now() - startedAt,
        },
      };
    }
  }

  async publish(
    input: WhatsAppWebPublicationInput,
  ): Promise<WhatsAppWebPublishResult> {
    let sendWasClicked = false;
    let sendClickStartedAt: Date | undefined;
    let sendClickedAt: Date | undefined;
    let currentStage: WhatsAppWebDiagnosticStage =
      "PRE_SEND_VALIDATION_STARTED";
    let mediaFallbackUsed = false;
    const baseMetadata = {
      publicationMode: "WEB_EXPERIMENTAL",
      whatsappDestinationType: "GROUP",
      profileKeySanitized: sanitizeWhatsAppWebProfileKey(
        input.channel.webProfileKey,
      ),
    };
    try {
      this.assertChannelEnabled(input.channel);
      if (this.config.dryRun) throw new Error("WHATSAPP_WEB_DISABLED");
      if (
        !input.channel.lastSuccessfulDryRunAt ||
        input.channel.lastSuccessfulDryRunConfigurationFingerprint !==
          whatsappWebConfigurationFingerprint(input.channel)
      )
        throw new Error("WHATSAPP_WEB_DRAFT_VALIDATION_FAILED");
      validateWhatsAppWebPublication(input);
      return await this.withConnectedSession(
        input.channel.webProfileKey,
        async (adapter) => {
          const location = await this.openExactGroup(
            adapter,
            input.channel.groupDisplayName,
          );
          if (location.status !== "GROUP_FOUND")
            throw new Error(location.errorCode);
          const media = await this.prepareMedia(input);
          mediaFallbackUsed = media.fallback;
          let operationError: unknown;
          try {
            try {
              await this.prepareDraft(adapter, input, media.path);
              await this.persistSendState({
                publicationId: input.publicationId,
                stage: "PRE_SEND_VALIDATION_STARTED",
                sendWasClicked: false,
                deliveryUncertain: false,
              });
              const trigger = await this.validatePreSend(
                adapter,
                input,
                Boolean(media.path),
              );
              currentStage = trigger.stage;
              await this.captureDebugDraft(adapter, "publish-ready");
              currentStage = "SEND_CLICK_STARTED";
              sendClickStartedAt = this.now();
              await this.persistSendState({
                publicationId: input.publicationId,
                stage: currentStage,
                sendWasClicked: false,
                sendClickStartedAt: sendClickStartedAt.toISOString(),
                deliveryUncertain: true,
              });
              await adapter.clickSendTrigger();
              sendWasClicked = true;
              sendClickedAt = this.now();
              currentStage = "SEND_CLICK_COMPLETED";
              await this.persistSendState({
                publicationId: input.publicationId,
                stage: currentStage,
                sendWasClicked: true,
                sendClickStartedAt: sendClickStartedAt.toISOString(),
                sendClickedAt: sendClickedAt.toISOString(),
                deliveryUncertain: true,
              });
              currentStage = "DELIVERY_CONFIRMATION_STARTED";
              await this.persistSendState({
                publicationId: input.publicationId,
                stage: currentStage,
                sendWasClicked: true,
                sendClickStartedAt: sendClickStartedAt.toISOString(),
                sendClickedAt: sendClickedAt.toISOString(),
                deliveryUncertain: true,
              });
              const confirmation = await adapter.confirmOutgoingMessage({
                affiliateUrl: input.affiliateUrl,
                textSnippet: uniqueSnippet(input.title),
                mediaExpected: Boolean(media.path),
                sentAfter: sendClickedAt,
                outgoingCountBefore: trigger.outgoingCount,
              });
              if (!confirmation.confirmed) {
                currentStage = confirmation.stage;
                return this.result(
                  "DELIVERY_UNCERTAIN",
                  sendWasClicked,
                  mediaFallbackUsed,
                  "WHATSAPP_WEB_DELIVERY_UNCERTAIN",
                  currentStage,
                  {
                    ...baseMetadata,
                    sendClickStartedAt: sendClickStartedAt.toISOString(),
                    sendClickedAt: sendClickedAt.toISOString(),
                    deliveryUncertain: true,
                    confirmationStage: confirmation.stage,
                  },
                );
              }
              currentStage = "DELIVERY_CONFIRMED";
              await this.persistSendState({
                publicationId: input.publicationId,
                stage: currentStage,
                sendWasClicked: true,
                sendClickStartedAt: sendClickStartedAt.toISOString(),
                sendClickedAt: sendClickedAt.toISOString(),
                deliveryUncertain: false,
              });
              return this.result(
                "PUBLISHED",
                true,
                mediaFallbackUsed,
                undefined,
                currentStage,
                {
                  ...baseMetadata,
                  sendClickStartedAt: sendClickStartedAt.toISOString(),
                  sendClickedAt: sendClickedAt.toISOString(),
                  deliveryConfirmedAt: this.now().toISOString(),
                  confirmationStrategy: "VISUAL_NEW_OUTGOING_MESSAGE",
                  confirmedMedia: Boolean(media.path),
                },
              );
            } catch (error) {
              operationError = error;
              throw error;
            } finally {
              if (!sendClickStartedAt && operationError) {
                await adapter.clearDraft().catch(() => undefined);
              }
            }
          } finally {
            await media.cleanup().catch(() => undefined);
          }
        },
      );
    } catch (error) {
      const clickStateUncertain = Boolean(sendClickStartedAt);
      const stage =
        error instanceof WhatsAppWebStageError ? error.stage : currentStage;
      const code = clickStateUncertain
        ? "WHATSAPP_WEB_DELIVERY_UNCERTAIN"
        : errorCode(error);
      return this.result(
        clickStateUncertain ? "DELIVERY_UNCERTAIN" : "FAILED",
        sendWasClicked,
        mediaFallbackUsed,
        code,
        stage,
        {
          ...baseMetadata,
          ...(sendClickStartedAt
            ? { sendClickStartedAt: sendClickStartedAt.toISOString() }
            : {}),
          ...(sendClickedAt
            ? { sendClickedAt: sendClickedAt.toISOString() }
            : {}),
          deliveryUncertain: clickStateUncertain,
        },
      );
    }
  }

  private assertChannelEnabled(channel: WhatsAppWebChannelConfiguration) {
    if (
      !this.config.enabled ||
      !channel.webAutomationEnabled ||
      !channel.channelEnabled ||
      channel.channelPaused
    )
      throw new Error("WHATSAPP_WEB_DISABLED");
    if (
      !channel.webAutomationOwnershipConfirmed ||
      !channel.webAutomationConfirmedAt
    )
      throw new Error("WHATSAPP_WEB_OWNERSHIP_NOT_CONFIRMED");
  }

  private async openSession(profileKey: string) {
    return this.launcher.launchPersistent({
      userDataDir: resolveWhatsAppWebProfilePath(
        this.config.userDataRoot,
        profileKey,
      ),
      headless: this.config.headless,
      actionTimeoutMs: this.config.actionTimeoutMs,
      navigationTimeoutMs: this.config.navigationTimeoutMs,
      confirmationTimeoutMs: this.config.confirmationTimeoutMs,
      slowMoMs: this.config.slowMoMs,
    });
  }

  private async withConnectedSession<T>(
    profileKey: string,
    operation: (adapter: WhatsAppWebPageAdapter) => Promise<T>,
    localDiagnostic?: {
      isFailure(result: T): boolean;
    },
  ): Promise<T> {
    return new WhatsAppWebSessionManager(
      this.config,
      this.launcher,
      this.profileLock,
    ).withConnectedSession(
      profileKey,
      operation,
      localDiagnostic
        ? {
            keepOpenOnErrorMs:
              this.dependencies.localDiagnosticKeepOpenOnErrorMs ?? 0,
            isFailure: localDiagnostic.isFailure,
          }
        : undefined,
    );
  }

  private async openExactGroup(adapter: WhatsAppWebPageAdapter, name: string) {
    const located = await adapter.locateGroupExact(name);
    if (located.status !== "GROUP_FOUND") return located;
    await adapter.openGroup(name);
    if (!(await adapter.verifyOpenedGroup(name))) {
      throw new WhatsAppWebStageError("GROUP_REOPEN_FAILED", {
        currentOrigin: "https://web.whatsapp.com",
        rootCause: "GROUP_REOPEN_FAILED",
        errorCode: "WHATSAPP_WEB_SELECTOR_MISMATCH",
      });
    }
    if (!(await adapter.verifyPublishPermission()))
      throw new Error("WHATSAPP_WEB_NO_PUBLISH_PERMISSION");
    return { ...located, publishPermission: true };
  }

  private async validatePreSend(
    adapter: WhatsAppWebPageAdapter,
    input: WhatsAppWebPublicationInput,
    mediaExpected: boolean,
    diagnostics?: WhatsAppWebSafeDiagnostics,
  ): Promise<WhatsAppWebSendTriggerInspection> {
    if (!(await adapter.verifyOpenedGroup(input.channel.groupDisplayName))) {
      throw new WhatsAppWebStageError(
        "PRE_SEND_GROUP_MISMATCH",
        {
          currentOrigin: "https://web.whatsapp.com",
          ...diagnostics,
          rootCause: "PRE_SEND_GROUP_MISMATCH",
          errorCode: "WHATSAPP_WEB_PRE_SEND_VALIDATION_FAILED",
        },
        "WHATSAPP_WEB_PRE_SEND_VALIDATION_FAILED",
      );
    }
    const inspection = await adapter.inspectPreparedDraft({
      affiliateUrl: input.affiliateUrl,
      textSnippet: uniqueSnippet(input.title),
      expectedText: input.message,
      mediaExpected,
    });
    if (
      inspection.uploadErrorVisible ||
      (mediaExpected && !inspection.mediaFound)
    ) {
      throw new WhatsAppWebStageError(
        "PRE_SEND_MEDIA_PREVIEW_MISSING",
        {
          currentOrigin: "https://web.whatsapp.com",
          ...diagnostics,
          previewDetected: inspection.mediaFound,
          uploadErrorVisible: inspection.uploadErrorVisible,
          rootCause: "PRE_SEND_MEDIA_PREVIEW_MISSING",
          errorCode: "WHATSAPP_WEB_PRE_SEND_VALIDATION_FAILED",
        },
        "WHATSAPP_WEB_PRE_SEND_VALIDATION_FAILED",
      );
    }
    if (!inspection.textSnippetFound) {
      throw new WhatsAppWebStageError(
        "PRE_SEND_CAPTION_MISSING",
        {
          currentOrigin: "https://web.whatsapp.com",
          ...diagnostics,
          captionDetected: false,
          rootCause: "PRE_SEND_CAPTION_MISSING",
          errorCode: "WHATSAPP_WEB_PRE_SEND_VALIDATION_FAILED",
        },
        "WHATSAPP_WEB_PRE_SEND_VALIDATION_FAILED",
      );
    }
    if (
      !inspection.affiliateUrlFound ||
      inspection.affiliateUrlOccurrences !== 1
    ) {
      throw new WhatsAppWebStageError(
        "PRE_SEND_AFFILIATE_URL_MISSING",
        {
          currentOrigin: "https://web.whatsapp.com",
          ...diagnostics,
          affiliateUrlOccurrences: inspection.affiliateUrlOccurrences,
          rootCause: "PRE_SEND_AFFILIATE_URL_MISSING",
          errorCode: "WHATSAPP_WEB_PRE_SEND_VALIDATION_FAILED",
        },
        "WHATSAPP_WEB_PRE_SEND_VALIDATION_FAILED",
      );
    }
    if (diagnostics) {
      diagnostics.previewDetected = inspection.mediaFound;
      diagnostics.captionDetected = inspection.textSnippetFound;
      diagnostics.draftValidated = true;
      diagnostics.uploadErrorVisible = false;
    }
    const trigger = await adapter.inspectSendTrigger({ mediaExpected });
    if (diagnostics) {
      diagnostics.strategiesTried = trigger.strategiesTried;
      diagnostics.candidateCount = trigger.candidateCount;
      diagnostics.visible = trigger.visible;
      diagnostics.enabled = trigger.enabled;
    }
    if (
      !trigger.found ||
      !trigger.visible ||
      !trigger.enabled ||
      trigger.candidateCount !== 1
    ) {
      throw new WhatsAppWebStageError(
        trigger.stage,
        {
          currentOrigin: "https://web.whatsapp.com",
          ...diagnostics,
          strategiesTried: trigger.strategiesTried,
          candidateCount: trigger.candidateCount,
          visible: trigger.visible,
          enabled: trigger.enabled,
          rootCause: trigger.stage,
          errorCode: "WHATSAPP_WEB_SEND_TRIGGER_FAILED",
        },
        "WHATSAPP_WEB_SEND_TRIGGER_FAILED",
      );
    }
    return trigger;
  }

  private async persistSendState(update: WhatsAppWebSendStateUpdate) {
    if (!this.dependencies.recordSendState) {
      throw new WhatsAppWebStageError(
        "SEND_STATE_PERSIST_FAILED",
        {
          currentOrigin: "https://web.whatsapp.com",
          rootCause: "SEND_STATE_PERSIST_FAILED",
          errorCode: "WHATSAPP_WEB_SEND_STATE_PERSIST_FAILED",
        },
        "WHATSAPP_WEB_SEND_STATE_PERSIST_FAILED",
      );
    }
    try {
      await this.dependencies.recordSendState(update);
    } catch {
      throw new WhatsAppWebStageError(
        "SEND_STATE_PERSIST_FAILED",
        {
          currentOrigin: "https://web.whatsapp.com",
          rootCause: "SEND_STATE_PERSIST_FAILED",
          errorCode: "WHATSAPP_WEB_SEND_STATE_PERSIST_FAILED",
        },
        "WHATSAPP_WEB_SEND_STATE_PERSIST_FAILED",
      );
    }
  }

  private async prepareDraft(
    adapter: WhatsAppWebPageAdapter,
    input: WhatsAppWebPublicationInput,
    mediaPath: string | null,
  ) {
    if (mediaPath) {
      await adapter.attachImage(mediaPath);
      await adapter.fillCaption(input.message);
    } else {
      await adapter.fillText(input.message);
    }
  }

  private async prepareMedia(
    input: WhatsAppWebPublicationInput,
    diagnostics?: WhatsAppWebSafeDiagnostics,
  ) {
    if (!input.channel.sendImage || !input.imageUrl)
      return {
        path: null,
        contentType: null,
        fallback: false,
        cleanup: async () => undefined,
      };
    let image: Awaited<ReturnType<typeof prepareRemoteImage>>;
    try {
      image = await (this.dependencies.prepareImage ?? prepareRemoteImage)(
        input.imageUrl,
      );
    } catch {
      if (!this.config.allowTextFallback) {
        throw new WhatsAppWebStageError(
          "MEDIA_UPLOAD_FAILED",
          {
            currentOrigin: "https://web.whatsapp.com",
            ...diagnostics,
            rootCause: "MEDIA_UPLOAD_FAILED",
            errorCode: "WHATSAPP_WEB_MEDIA_PREPARATION_FAILED",
          },
          "WHATSAPP_WEB_MEDIA_PREPARATION_FAILED",
        );
      }
      return {
        path: null,
        contentType: null,
        fallback: true,
        cleanup: async () => undefined,
      };
    }

    let directory: string | null = null;
    try {
      const extension = extname(image.filename).toLowerCase();
      if (diagnostics) {
        diagnostics.tempFileExtension = extension;
      }
      if (!isCompatibleImageFile(image.contentType, extension)) {
        throw new WhatsAppWebStageError(
          "FILE_MIME_INVALID",
          {
            currentOrigin: "https://web.whatsapp.com",
            ...diagnostics,
            tempFileExtension: extension,
            rootCause: "FILE_MIME_INVALID",
            errorCode: "WHATSAPP_WEB_MEDIA_PREPARATION_FAILED",
          },
          "WHATSAPP_WEB_MEDIA_PREPARATION_FAILED",
        );
      }
      directory = await mkdtemp(join(tmpdir(), "affiliate-wa-"));
      const path = join(directory, image.filename);
      try {
        await (this.dependencies.writeTempFile ?? writeFile)(path, image.bytes);
      } catch {
        throw new WhatsAppWebStageError(
          "FILE_NOT_WRITTEN",
          {
            currentOrigin: "https://web.whatsapp.com",
            ...diagnostics,
            tempFileExtension: extension,
            rootCause: "FILE_NOT_WRITTEN",
            errorCode: "WHATSAPP_WEB_MEDIA_PREPARATION_FAILED",
          },
          "WHATSAPP_WEB_MEDIA_PREPARATION_FAILED",
        );
      }
      let fileStat: Awaited<ReturnType<typeof stat>>;
      try {
        fileStat = await (this.dependencies.statTempFile ?? stat)(path);
      } catch {
        throw new WhatsAppWebStageError(
          "FILE_NOT_FOUND_ON_DISK",
          {
            currentOrigin: "https://web.whatsapp.com",
            ...diagnostics,
            tempFileExists: false,
            tempFileExtension: extension,
            rootCause: "FILE_NOT_FOUND_ON_DISK",
            errorCode: "WHATSAPP_WEB_MEDIA_PREPARATION_FAILED",
          },
          "WHATSAPP_WEB_MEDIA_PREPARATION_FAILED",
        );
      }
      if (diagnostics) {
        diagnostics.tempFileExists = true;
        diagnostics.tempFileSize = fileStat.size;
      }
      if (!fileStat.isFile()) {
        throw new WhatsAppWebStageError(
          "FILE_NOT_FOUND_ON_DISK",
          {
            currentOrigin: "https://web.whatsapp.com",
            ...diagnostics,
            tempFileExists: false,
            rootCause: "FILE_NOT_FOUND_ON_DISK",
            errorCode: "WHATSAPP_WEB_MEDIA_PREPARATION_FAILED",
          },
          "WHATSAPP_WEB_MEDIA_PREPARATION_FAILED",
        );
      }
      if (fileStat.size <= 0) {
        throw new WhatsAppWebStageError(
          "FILE_SIZE_ZERO",
          {
            currentOrigin: "https://web.whatsapp.com",
            ...diagnostics,
            tempFileExists: true,
            tempFileSize: fileStat.size,
            rootCause: "FILE_SIZE_ZERO",
            errorCode: "WHATSAPP_WEB_MEDIA_PREPARATION_FAILED",
          },
          "WHATSAPP_WEB_MEDIA_PREPARATION_FAILED",
        );
      }
      return {
        path,
        contentType: image.contentType,
        fallback: false,
        cleanup: async () => rm(directory!, { recursive: true, force: true }),
      };
    } catch (error) {
      if (directory)
        await rm(directory, { recursive: true, force: true }).catch(
          () => undefined,
        );
      throw error;
    }
  }

  private async captureDebugDraft(
    adapter: WhatsAppWebPageAdapter,
    stage: "dry-run-ready" | "publish-ready",
  ) {
    if (!this.config.debugScreenshots || !adapter.capturePreparedDraft) return;
    const root = resolve(this.config.debugRoot);
    await mkdir(root, { recursive: true });
    const timestamp = this.now().toISOString().replace(/[:.]/g, "-");
    await adapter.capturePreparedDraft(join(root, `${stage}-${timestamp}.png`));
  }

  private result(
    status: WhatsAppWebPublishResult["status"],
    sendWasClicked: boolean,
    mediaFallbackUsed: boolean,
    errorCodeValue: string | undefined,
    stage: WhatsAppWebDiagnosticStage,
    metadata: Record<string, unknown>,
  ): WhatsAppWebPublishResult {
    return {
      status,
      publicationMode: "WEB_EXPERIMENTAL",
      destinationType: "GROUP",
      sendWasClicked,
      ...(typeof metadata.sendClickStartedAt === "string"
        ? { sendClickStartedAt: metadata.sendClickStartedAt }
        : {}),
      ...(typeof metadata.sendClickedAt === "string"
        ? { sendClickedAt: metadata.sendClickedAt }
        : {}),
      deliveryConfirmed: status === "PUBLISHED",
      deliveryUncertain: status === "DELIVERY_UNCERTAIN",
      stage,
      rootCause: stage,
      mediaFallbackUsed,
      ...(errorCodeValue ? { errorCode: errorCodeValue } : {}),
      metadata: {
        ...metadata,
        stage,
        rootCause: stage,
        sendWasClicked,
        mediaFallbackUsed,
      },
    };
  }
}

function uniqueSnippet(title: string) {
  return title.replace(/\s+/g, " ").trim().slice(0, 60);
}

function isCompatibleImageFile(contentType: string, extension: string) {
  const allowed = new Map<string, ReadonlySet<string>>([
    ["image/jpeg", new Set([".jpg", ".jpeg"])],
    ["image/png", new Set([".png"])],
    ["image/webp", new Set([".webp"])],
    ["image/gif", new Set([".gif"])],
  ]);
  return (
    contentType.startsWith("image/") &&
    allowed.get(contentType)?.has(extension) === true
  );
}

function errorCode(error: unknown): WhatsAppWebErrorCode {
  const message = error instanceof Error ? error.message : String(error);
  return /^WHATSAPP_WEB_|^(REDIS_UNAVAILABLE|LOCK_ALREADY_HELD)$/.test(message)
    ? (message as WhatsAppWebErrorCode)
    : "WHATSAPP_WEB_UNEXPECTED_STATE";
}
