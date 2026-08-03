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
  WhatsAppWebMediaLayoutInspection,
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
  publicationStatus?: string;
  publicationMetadata?: unknown;
  confirmSend?: boolean;
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
  captionVisibleTextConfirmed: boolean;
  captionOverlayScoped: boolean;
  captionTopmostConfirmed: boolean;
  captionActiveElementConfirmed: boolean;
  captionExactSnapshotConfirmed: boolean;
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
  captionStable: boolean;
  affiliateUrlOccurrenceCount: number;
  captionVisibleTextConfirmed: boolean;
  captionOverlayScoped: boolean;
  captionTopmostConfirmed: boolean;
  captionActiveElementConfirmed: boolean;
  captionExactSnapshotConfirmed: boolean;
  sendTriggerTrialSucceeded: boolean;
  stage: WhatsAppWebDiagnosticStage;
  errorCode?: string;
  diagnostics: WhatsAppWebSafeDiagnostics;
};

export type WhatsAppWebInspectDraftResult = {
  status:
    | "AWAITING_VISUAL_INSPECTION_COMPLETED"
    | "VISUAL_LAYOUT_INSPECTION_REQUIRED"
    | "VISUAL_DRAFT_REJECTED"
    | "FAILED";
  captionVisibleTextConfirmed: boolean;
  captionOverlayScoped: boolean;
  captionTopmostConfirmed: boolean;
  captionActiveElementConfirmed: boolean;
  captionExactSnapshotConfirmed: boolean;
  affiliateUrlOccurrenceCount: number;
  sendTriggerTrialSucceeded: boolean;
  visualDraftInspectionConfirmed: boolean;
  visualDraftInspectionFingerprint: string;
  sendCalled: false;
  draftCleared: boolean;
  stage: WhatsAppWebDiagnosticStage;
  errorCode?: string;
  diagnostics: WhatsAppWebSafeDiagnostics;
};

export type WhatsAppWebInspectLayoutResult =
  WhatsAppWebMediaLayoutInspection & {
    holdMs: number;
    browserHeldOpen: boolean;
    draftCleared: boolean;
    stage: WhatsAppWebDiagnosticStage;
    errorCode?: string;
  };

export type WhatsAppWebSendStateUpdate = {
  publicationId: string;
  stage: WhatsAppWebDiagnosticStage;
  sendWasClicked: boolean;
  sendClickStartedAt?: string;
  sendClickedAt?: string;
  deliveryUncertain: boolean;
};

export type WhatsAppWebRealSendEligibilityResult = {
  globalExperimentalEnabled: boolean;
  dryRunEnabled: boolean;
  channelEnabled: boolean;
  channelPaused: boolean;
  publicationMode: string;
  webAutomationEnabled: boolean;
  ownershipConfirmed: boolean;
  dryRunFingerprintValid: boolean;
  publicationEligible: boolean;
  visualDraftInspectionValid: boolean;
  realSendEligible: boolean;
  blockingReason: WhatsAppWebErrorCode | null;
};

export function validateRealSendEligibility(input: {
  config: WhatsAppWebRuntimeConfig;
  channel: WhatsAppWebChannelConfiguration;
  publication: {
    status: string;
    metadata: unknown;
    messageSnapshot?: string;
    imageSnapshot?: string | null | undefined;
  };
  confirmSend: boolean;
}): WhatsAppWebRealSendEligibilityResult {
  const metadata =
    input.publication.metadata &&
    typeof input.publication.metadata === "object" &&
    !Array.isArray(input.publication.metadata)
      ? (input.publication.metadata as Record<string, unknown>)
      : {};
  const dryRunFingerprintValid = Boolean(
    input.channel.lastSuccessfulDryRunAt &&
    input.channel.lastSuccessfulDryRunConfigurationFingerprint ===
      whatsappWebConfigurationFingerprint(input.channel),
  );
  const deliveryStateRequiresAuthorization =
    metadata.deliveryUncertain === true ||
    typeof metadata.sendClickStartedAt === "string";
  const retryAuthorized = metadata.retryAuthorized === true;
  const visualDraftInspectionValid = Boolean(
    metadata.visualDraftInspectionConfirmed === true &&
    input.publication.messageSnapshot !== undefined &&
    metadata.lastVisualDraftInspectionFingerprint ===
      whatsappWebVisualDraftInspectionFingerprint({
        channel: input.channel,
        messageSnapshot: input.publication.messageSnapshot,
        imageSnapshot: input.publication.imageSnapshot,
      }),
  );
  const publicationEligible =
    input.publication.status !== "PUBLISHED" &&
    (!deliveryStateRequiresAuthorization || retryAuthorized) &&
    (input.publication.status !== "PUBLICATION_FAILED" || retryAuthorized);

  let blockingReason: WhatsAppWebErrorCode | null = null;
  if (!input.confirmSend) {
    blockingReason = "WHATSAPP_WEB_CONFIRM_SEND_REQUIRED";
  } else if (!input.config.enabled) {
    blockingReason = "WHATSAPP_WEB_GLOBAL_FEATURE_DISABLED";
  } else if (input.config.dryRun) {
    blockingReason = "WHATSAPP_WEB_REAL_SEND_DISABLED_BY_DRY_RUN";
  } else if (input.channel.channelType !== "WHATSAPP_GROUPS") {
    blockingReason = "WHATSAPP_WEB_CHANNEL_TYPE_INVALID";
  } else if (input.channel.publicationMode !== "WEB_EXPERIMENTAL") {
    blockingReason = "WHATSAPP_WEB_PUBLICATION_MODE_INVALID";
  } else if (!input.channel.channelEnabled) {
    blockingReason = "WHATSAPP_WEB_CHANNEL_DISABLED";
  } else if (input.channel.channelPaused) {
    blockingReason = "WHATSAPP_WEB_CHANNEL_PAUSED";
  } else if (!input.channel.webAutomationEnabled) {
    blockingReason = "WHATSAPP_WEB_AUTOMATION_DISABLED";
  } else if (
    !input.channel.webAutomationOwnershipConfirmed ||
    !input.channel.webAutomationConfirmedAt
  ) {
    blockingReason = "WHATSAPP_WEB_OWNERSHIP_NOT_CONFIRMED";
  } else if (!dryRunFingerprintValid) {
    blockingReason = "WHATSAPP_WEB_DRY_RUN_FINGERPRINT_INVALID";
  } else if (input.publication.status === "PUBLISHED") {
    blockingReason = "WHATSAPP_WEB_PUBLICATION_ALREADY_PUBLISHED";
  } else if (deliveryStateRequiresAuthorization && !retryAuthorized) {
    blockingReason = "WHATSAPP_WEB_DELIVERY_UNCERTAIN";
  } else if (
    input.publication.status === "PUBLICATION_FAILED" &&
    !retryAuthorized
  ) {
    blockingReason = "WHATSAPP_WEB_RETRY_NOT_AUTHORIZED";
  } else if (!visualDraftInspectionValid) {
    blockingReason = "WHATSAPP_WEB_VISUAL_DRAFT_INSPECTION_REQUIRED";
  } else if (!publicationEligible) {
    blockingReason = "WHATSAPP_WEB_PUBLICATION_INELIGIBLE";
  }

  return {
    globalExperimentalEnabled: input.config.enabled,
    dryRunEnabled: input.config.dryRun,
    channelEnabled: input.channel.channelEnabled,
    channelPaused: input.channel.channelPaused,
    publicationMode: input.channel.publicationMode,
    webAutomationEnabled: input.channel.webAutomationEnabled,
    ownershipConfirmed: Boolean(
      input.channel.webAutomationOwnershipConfirmed &&
      input.channel.webAutomationConfirmedAt,
    ),
    dryRunFingerprintValid,
    publicationEligible,
    visualDraftInspectionValid,
    realSendEligible: blockingReason === null,
    blockingReason,
  };
}

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
  inspectDraft(
    input: WhatsAppWebPublicationInput,
    options: {
      holdMs: number;
      confirmVisualDraft: () => Promise<boolean>;
      devtools?: boolean;
    },
  ): Promise<WhatsAppWebInspectDraftResult>;
  inspectLayout(
    input: WhatsAppWebPublicationInput,
    options: { holdMs: number; devtools?: boolean },
  ): Promise<WhatsAppWebInspectLayoutResult>;
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

export function whatsappWebVisualDraftInspectionFingerprint(input: {
  channel: WhatsAppWebChannelConfiguration;
  messageSnapshot: string;
  imageSnapshot?: string | null | undefined;
}) {
  const digest = (value: string) =>
    createHash("sha256").update(value).digest("hex");
  return createHash("sha256")
    .update(
      JSON.stringify({
        channelId: input.channel.channelId,
        groupDisplayName: input.channel.groupDisplayName
          .replace(/\s+/g, " ")
          .trim(),
        profileKey: sanitizeWhatsAppWebProfileKey(input.channel.webProfileKey),
        sendImage: input.channel.sendImage,
        messageSnapshotHash: digest(input.messageSnapshot),
        imageSnapshotHash: digest(input.imageSnapshot ?? "NO_IMAGE"),
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
      captionVisibleTextConfirmed: false,
      captionOverlayScoped: false,
      captionTopmostConfirmed: false,
      captionActiveElementConfirmed: false,
      captionExactSnapshotConfirmed: false,
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
                const caption = await adapter.fillCaption({
                  text: input.message,
                  affiliateUrl: input.affiliateUrl,
                  textSnippet: uniqueSnippet(input.title),
                });
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
                !inspection.mediaFound ||
                !inspection.captionStable ||
                inspection.uploadInProgressVisible ||
                !inspection.captionVisibleTextConfirmed ||
                !inspection.captionOverlayScoped ||
                !inspection.captionTopmostConfirmed ||
                !inspection.captionActiveElementConfirmed ||
                !inspection.captionExactSnapshotConfirmed
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
              Object.assign(diagnostics, inspection.diagnostics);
              progress.captionVisibleTextConfirmed =
                inspection.captionVisibleTextConfirmed;
              progress.captionOverlayScoped = inspection.captionOverlayScoped;
              progress.captionTopmostConfirmed =
                inspection.captionTopmostConfirmed;
              progress.captionActiveElementConfirmed =
                inspection.captionActiveElementConfirmed;
              progress.captionExactSnapshotConfirmed =
                inspection.captionExactSnapshotConfirmed;
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
      captionStable: false,
      affiliateUrlOccurrenceCount: 0,
      captionVisibleTextConfirmed: false,
      captionOverlayScoped: false,
      captionTopmostConfirmed: false,
      captionActiveElementConfirmed: false,
      captionExactSnapshotConfirmed: false,
      sendTriggerTrialSucceeded: false,
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
              const prepared = await this.prepareDraft(
                adapter,
                input,
                media.path,
              );
              if (prepared.attachment) {
                Object.assign(diagnostics, prepared.attachment);
              }
              if (prepared.caption) {
                Object.assign(diagnostics, prepared.caption);
                progress.captionStable = prepared.caption.captionStable;
                progress.affiliateUrlOccurrenceCount =
                  prepared.caption.affiliateUrlOccurrenceCount;
                progress.captionVisibleTextConfirmed =
                  prepared.caption.captionVisibleTextConfirmed;
                progress.captionOverlayScoped =
                  prepared.caption.captionOverlayScoped;
                progress.captionTopmostConfirmed =
                  prepared.caption.captionTopmostConfirmed;
                progress.captionActiveElementConfirmed =
                  prepared.caption.captionActiveElementConfirmed;
                progress.captionExactSnapshotConfirmed =
                  prepared.caption.captionExactSnapshotConfirmed;
              }
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
              progress.sendTriggerTrialSucceeded = trigger.trialClickSucceeded;
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
          if (cleanupError) throw cleanupError;
          if (operationError) throw operationError;
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

  async inspectLayout(
    input: WhatsAppWebPublicationInput,
    options: { holdMs: number; devtools?: boolean },
  ): Promise<WhatsAppWebInspectLayoutResult> {
    this.assertChannelEnabled(input.channel);
    if (!this.config.dryRun) throw new Error("WHATSAPP_WEB_DISABLED");
    if (options.holdMs < 5_000 || options.holdMs > 60_000) {
      throw new Error("WHATSAPP_WEB_UNEXPECTED_STATE");
    }
    validateWhatsAppWebPublication(input);
    return this.withConnectedSession(
      input.channel.webProfileKey,
      async (adapter) => {
        const location = await this.openExactGroup(
          adapter,
          input.channel.groupDisplayName,
        );
        if (location.status !== "GROUP_FOUND") {
          throw new Error(location.errorCode);
        }
        const media = await this.prepareMedia(input);
        if (!media.path) {
          throw new Error("WHATSAPP_WEB_MEDIA_PREPARATION_FAILED");
        }
        let layout: WhatsAppWebMediaLayoutInspection | null = null;
        let draftCleared = false;
        let inspectionError: unknown;
        try {
          await adapter.captureMediaEditorBaseline();
          await adapter.attachImage(media.path);
          try {
            layout = await adapter.inspectMediaLayout();
          } catch (error) {
            inspectionError = error;
          }
          await adapter.holdDraftOpen(options.holdMs);
        } finally {
          await adapter.clearDraft().catch(() => undefined);
          draftCleared = await adapter.isDraftClear().catch(() => false);
          await media.cleanup().catch(() => undefined);
        }
        if (inspectionError || !layout) {
          return {
            status: "CAPTION_TARGET_NOT_RESOLVED" as const,
            previewFound: true,
            sendTriggerFound: false,
            sendTriggerCandidateCount: 0,
            closeTriggerFound: false,
            surfaceCandidateCount: 0,
            captionCandidateCount: 0,
            selectedCaptionCandidateIndex: null,
            candidateDecisions: [],
            captionCandidates: [],
            sendCalled: false as const,
            holdMs: options.holdMs,
            browserHeldOpen: true,
            draftCleared,
            stage: "CAPTION_TARGET_NOT_RESOLVED" as const,
            errorCode: inspectionError
              ? errorCode(inspectionError)
              : "WHATSAPP_WEB_SELECTOR_MISMATCH",
          };
        }
        return {
          ...layout,
          holdMs: options.holdMs,
          browserHeldOpen: true,
          draftCleared,
          stage:
            layout.status === "LAYOUT_INSPECTION_READY"
              ? "LAYOUT_INSPECTION_READY"
              : layout.status,
        };
      },
      {
        isFailure: () => false,
        ...(options.devtools ? { devtools: true } : {}),
      },
    );
  }

  async inspectDraft(
    input: WhatsAppWebPublicationInput,
    options: {
      holdMs: number;
      confirmVisualDraft: () => Promise<boolean>;
      devtools?: boolean;
    },
  ): Promise<WhatsAppWebInspectDraftResult> {
    const startedAt = Date.now();
    const fingerprint = whatsappWebVisualDraftInspectionFingerprint({
      channel: input.channel,
      messageSnapshot: input.message,
      imageSnapshot: input.imageUrl,
    });
    const progress = {
      captionVisibleTextConfirmed: false,
      captionOverlayScoped: false,
      captionTopmostConfirmed: false,
      captionActiveElementConfirmed: false,
      captionExactSnapshotConfirmed: false,
      affiliateUrlOccurrenceCount: 0,
      sendTriggerTrialSucceeded: false,
      visualDraftInspectionConfirmed: false,
      visualDraftInspectionFingerprint: fingerprint,
      sendCalled: false as const,
      draftCleared: false,
    };
    const diagnostics: WhatsAppWebSafeDiagnostics = {
      currentOrigin: "https://web.whatsapp.com",
      draftValidated: false,
      draftCleared: false,
    };
    let stage: WhatsAppWebDiagnosticStage = "PRE_SEND_VALIDATION_STARTED";
    try {
      this.assertChannelEnabled(input.channel);
      if (!this.config.dryRun) throw new Error("WHATSAPP_WEB_DISABLED");
      if (options.holdMs < 5_000 || options.holdMs > 60_000) {
        throw new Error("WHATSAPP_WEB_UNEXPECTED_STATE");
      }
      validateWhatsAppWebPublication(input);
      return await this.withConnectedSession(
        input.channel.webProfileKey,
        async (adapter) => {
          const location = await this.openExactGroup(
            adapter,
            input.channel.groupDisplayName,
          );
          if (location.status !== "GROUP_FOUND") {
            throw new Error(location.errorCode);
          }
          const media = await this.prepareMedia(input, diagnostics);
          let operationError: unknown;
          let cleanupError: unknown;
          let previewOpened = false;
          try {
            try {
              if (media.path) {
                await adapter.captureMediaEditorBaseline();
                const attachment = await adapter.attachImage(media.path);
                previewOpened = attachment.previewDetected;
                Object.assign(diagnostics, attachment);
                const caption = await adapter.fillCaption({
                  text: input.message,
                  affiliateUrl: input.affiliateUrl,
                  textSnippet: uniqueSnippet(input.title),
                });
                Object.assign(diagnostics, caption);
              } else {
                await adapter.fillText(input.message);
              }
              const trigger = await this.validatePreSend(
                adapter,
                input,
                Boolean(media.path),
                diagnostics,
              );
              stage = "READY_TO_COMMIT_SEND";
              progress.captionVisibleTextConfirmed =
                diagnostics.captionVisibleTextConfirmed === true;
              progress.captionOverlayScoped =
                diagnostics.captionOverlayScoped === true;
              progress.captionTopmostConfirmed =
                diagnostics.captionTopmostConfirmed === true;
              progress.captionActiveElementConfirmed =
                diagnostics.captionActiveElementConfirmed === true;
              progress.captionExactSnapshotConfirmed =
                diagnostics.captionExactSnapshotConfirmed === true;
              progress.affiliateUrlOccurrenceCount =
                diagnostics.affiliateUrlOccurrenceCount ?? 0;
              progress.sendTriggerTrialSucceeded = trigger.trialClickSucceeded;
              const [, humanConfirmed] = await Promise.all([
                adapter.holdDraftOpen(options.holdMs),
                options.confirmVisualDraft().catch(() => false),
              ]);
              progress.visualDraftInspectionConfirmed = humanConfirmed;
            } catch (error) {
              operationError = error;
              if (previewOpened) {
                stage =
                  error instanceof WhatsAppWebStageError
                    ? error.stage
                    : "CAPTION_TARGET_NOT_RESOLVED";
                await adapter.holdDraftOpen(options.holdMs);
              }
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
          if (cleanupError) throw cleanupError;
          if (operationError) {
            if (!previewOpened) throw operationError;
            return {
              ...progress,
              status: "VISUAL_LAYOUT_INSPECTION_REQUIRED" as const,
              stage:
                stage === "CAPTION_NOT_INSIDE_MEDIA_OVERLAY"
                  ? ("CAPTION_TARGET_NOT_RESOLVED" as const)
                  : stage,
              errorCode: errorCode(operationError),
              diagnostics: {
                ...diagnostics,
                ...(operationError instanceof WhatsAppWebStageError
                  ? operationError.diagnostics
                  : {}),
                durationMs: Date.now() - startedAt,
              },
            };
          }
          return {
            ...progress,
            status: progress.visualDraftInspectionConfirmed
              ? ("AWAITING_VISUAL_INSPECTION_COMPLETED" as const)
              : ("VISUAL_DRAFT_REJECTED" as const),
            stage,
            diagnostics: {
              ...diagnostics,
              durationMs: Date.now() - startedAt,
            },
          };
        },
        {
          isFailure: () => false,
          ...(options.devtools ? { devtools: true } : {}),
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
      const eligibility = validateRealSendEligibility({
        config: this.config,
        channel: input.channel,
        publication: {
          status: input.publicationStatus ?? "SCHEDULED",
          metadata: input.publicationMetadata,
          messageSnapshot: input.message,
          imageSnapshot: input.imageUrl,
        },
        confirmSend: input.confirmSend ?? true,
      });
      if (!eligibility.realSendEligible) {
        throw new Error(
          eligibility.blockingReason ?? "WHATSAPP_WEB_PUBLICATION_INELIGIBLE",
        );
      }
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
              let trigger = await this.validatePreSend(
                adapter,
                input,
                Boolean(media.path),
              );
              currentStage = trigger.stage;
              await this.captureDebugDraft(adapter, "publish-ready");
              trigger = await this.validatePreSend(
                adapter,
                input,
                Boolean(media.path),
              );
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
      devtools?: boolean;
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
            ...(localDiagnostic.devtools ? { devtools: true } : {}),
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
    if (mediaExpected) {
      const visualStage: WhatsAppWebDiagnosticStage | null =
        !inspection.captionOverlayScoped
          ? "CAPTION_NOT_INSIDE_MEDIA_OVERLAY"
          : !inspection.captionTopmostConfirmed
            ? "CAPTION_NOT_TOPMOST"
            : !inspection.captionActiveElementConfirmed
              ? "CAPTION_FOCUS_NOT_CONFIRMED"
              : !inspection.captionVisibleTextConfirmed
                ? inspection.captionLengthObserved === 0
                  ? "CAPTION_VISIBLE_TEXT_MISSING"
                  : "CAPTION_VISIBLE_TEXT_MISMATCH"
                : !inspection.captionExactSnapshotConfirmed
                  ? "CAPTION_VISIBLE_TEXT_MISMATCH"
                  : null;
      if (visualStage) {
        throw new WhatsAppWebStageError(
          visualStage,
          {
            ...diagnostics,
            ...inspection.diagnostics,
            currentOrigin: "https://web.whatsapp.com",
            rootCause: visualStage,
            errorCode: "WHATSAPP_WEB_DRAFT_VALIDATION_FAILED",
          },
          "WHATSAPP_WEB_DRAFT_VALIDATION_FAILED",
        );
      }
    }
    if (inspection.uploadInProgressVisible) {
      throw new WhatsAppWebStageError(
        "PRE_SEND_MEDIA_UPLOAD_IN_PROGRESS",
        {
          currentOrigin: "https://web.whatsapp.com",
          ...diagnostics,
          uploadInProgressVisible: true,
          rootCause: "PRE_SEND_MEDIA_UPLOAD_IN_PROGRESS",
          errorCode: "WHATSAPP_WEB_PRE_SEND_VALIDATION_FAILED",
        },
        "WHATSAPP_WEB_PRE_SEND_VALIDATION_FAILED",
      );
    }
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
    if (!inspection.captionStable) {
      const captionStage: WhatsAppWebDiagnosticStage =
        inspection.captionLengthObserved === 0
          ? "CAPTION_CONTENT_LOST"
          : "CAPTION_CONTENT_MISMATCH";
      throw new WhatsAppWebStageError(
        captionStage,
        {
          currentOrigin: "https://web.whatsapp.com",
          ...diagnostics,
          captionStable: false,
          captionLengthExpected: inspection.captionLengthExpected,
          captionLengthObserved: inspection.captionLengthObserved,
          rootCause: captionStage,
          errorCode: "WHATSAPP_WEB_DRAFT_VALIDATION_FAILED",
        },
        "WHATSAPP_WEB_DRAFT_VALIDATION_FAILED",
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
      Object.assign(diagnostics, inspection.diagnostics);
      diagnostics.previewDetected = inspection.mediaFound;
      diagnostics.captionDetected = inspection.textSnippetFound;
      diagnostics.captionInputFound = inspection.captionLengthObserved > 0;
      diagnostics.captionInputVisible = inspection.captionLengthObserved > 0;
      diagnostics.captionInputEditable = true;
      diagnostics.captionStable = inspection.captionStable;
      diagnostics.captionLengthExpected = inspection.captionLengthExpected;
      diagnostics.captionLengthObserved = inspection.captionLengthObserved;
      diagnostics.affiliateUrlOccurrenceCount =
        inspection.affiliateUrlOccurrences;
      diagnostics.titleSnippetConfirmed = inspection.textSnippetFound;
      diagnostics.draftValidated = true;
      diagnostics.uploadErrorVisible = false;
    }
    const trigger = await adapter.inspectSendTrigger({ mediaExpected });
    if (diagnostics) {
      diagnostics.strategiesTried = trigger.strategiesTried;
      diagnostics.candidateCount = trigger.candidateCount;
      diagnostics.visible = trigger.visible;
      diagnostics.enabled = trigger.enabled;
      diagnostics.sendTriggerBoundingBoxPresent = trigger.boundingBoxPresent;
      diagnostics.sendTriggerTopmostConfirmed = trigger.topmostConfirmed;
      diagnostics.sendTriggerTrialSucceeded = trigger.trialClickSucceeded;
    }
    if (
      !trigger.found ||
      !trigger.visible ||
      !trigger.enabled ||
      trigger.candidateCount !== 1 ||
      !trigger.boundingBoxPresent ||
      !trigger.topmostConfirmed ||
      !trigger.trialClickSucceeded
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
      await adapter.captureMediaEditorBaseline();
      const attachment = await adapter.attachImage(mediaPath);
      const caption = await adapter.fillCaption({
        text: input.message,
        affiliateUrl: input.affiliateUrl,
        textSnippet: uniqueSnippet(input.title),
      });
      return { attachment, caption };
    } else {
      await adapter.fillText(input.message);
      return { attachment: null, caption: null };
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
