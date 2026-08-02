import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
} from "./whatsapp-web-types";

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
  configurationFingerprint: string;
  errorCode?: string;
};

export type WhatsAppWebPublishResult = {
  status: "PUBLISHED" | "FAILED" | "DELIVERY_UNCERTAIN" | "SKIPPED";
  publicationMode: "WEB_EXPERIMENTAL";
  destinationType: "GROUP";
  sendWasClicked: boolean;
  mediaFallbackUsed: boolean;
  errorCode?: string;
  metadata: Record<string, unknown>;
};

export interface WhatsAppGroupsWebPublisherContract {
  healthCheck(input: { profileKey: string }): Promise<WhatsAppWebHealthResult>;
  locateGroup(input: {
    profileKey: string;
    groupDisplayName: string;
  }): Promise<WhatsAppGroupLocationResult>;
  dryRun(input: WhatsAppWebPublicationInput): Promise<WhatsAppWebDryRunResult>;
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
                status: "GROUP_FOUND" as const,
                exactMatch: true,
                publishPermission: true,
              }
            : {
                status: "NO_PUBLISH_PERMISSION" as const,
                exactMatch: true,
                publishPermission: false,
                errorCode: "WHATSAPP_WEB_NO_PUBLISH_PERMISSION" as const,
              };
        },
      );
    } catch (error) {
      const code = errorCode(error);
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

  async dryRun(
    input: WhatsAppWebPublicationInput,
  ): Promise<WhatsAppWebDryRunResult> {
    const fingerprint = whatsappWebConfigurationFingerprint(input.channel);
    const base = {
      dryRun: true as const,
      dryRunAt: this.now().toISOString(),
      groupExactMatch: false,
      affiliateUrlConfirmedInDraft: false,
      mediaPrepared: false,
      mediaFallbackUsed: false,
      draftCleared: false,
      configurationFingerprint: fingerprint,
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
          const media = await this.prepareMedia(input);
          try {
            await this.prepareDraft(adapter, input, media.path);
            const inspection = await adapter.inspectPreparedDraft({
              affiliateUrl: input.affiliateUrl,
              textSnippet: uniqueSnippet(input.title),
              mediaExpected: Boolean(media.path),
            });
            if (
              !inspection.affiliateUrlFound ||
              !inspection.textSnippetFound ||
              !inspection.mediaFound
            ) {
              throw new Error("WHATSAPP_WEB_DRAFT_VALIDATION_FAILED");
            }
            await this.captureDebugDraft(adapter, "dry-run-ready");
            await adapter.clearDraft();
            const draftCleared = await adapter.isDraftClear();
            if (!draftCleared)
              throw new Error("WHATSAPP_WEB_DRAFT_CLEANUP_FAILED");
            return {
              ...base,
              status: "READY_TO_SEND",
              groupExactMatch: true,
              affiliateUrlConfirmedInDraft: true,
              mediaPrepared: Boolean(media.path),
              mediaFallbackUsed: media.fallback,
              draftCleared: true,
            };
          } finally {
            await media.cleanup();
          }
        },
      );
    } catch (error) {
      return { ...base, status: "FAILED", errorCode: errorCode(error) };
    }
  }

  async publish(
    input: WhatsAppWebPublicationInput,
  ): Promise<WhatsAppWebPublishResult> {
    let sendWasClicked = false;
    let mediaFallbackUsed = false;
    const baseMetadata = {
      publicationMode: "WEB_EXPERIMENTAL",
      whatsappDestinationType: "GROUP",
      groupDisplayNameSnapshot: input.channel.groupDisplayName,
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
          try {
            await this.prepareDraft(adapter, input, media.path);
            const inspection = await adapter.inspectPreparedDraft({
              affiliateUrl: input.affiliateUrl,
              textSnippet: uniqueSnippet(input.title),
              mediaExpected: Boolean(media.path),
            });
            if (
              !inspection.affiliateUrlFound ||
              !inspection.textSnippetFound ||
              !inspection.mediaFound
            )
              throw new Error("WHATSAPP_WEB_DRAFT_VALIDATION_FAILED");
            await this.captureDebugDraft(adapter, "publish-ready");
            await adapter.send();
            sendWasClicked = true;
            const sendClickedAt = this.now();
            const confirmation = await adapter.confirmOutgoingMessage({
              affiliateUrl: input.affiliateUrl,
              textSnippet: uniqueSnippet(input.title),
              mediaExpected: Boolean(media.path),
              sentAfter: sendClickedAt,
            });
            if (!confirmation.confirmed) {
              return this.result(
                "DELIVERY_UNCERTAIN",
                true,
                mediaFallbackUsed,
                "WHATSAPP_WEB_DELIVERY_UNCERTAIN",
                {
                  ...baseMetadata,
                  sendClickedAt: sendClickedAt.toISOString(),
                  deliveryUncertain: true,
                },
              );
            }
            return this.result(
              "PUBLISHED",
              true,
              mediaFallbackUsed,
              undefined,
              {
                ...baseMetadata,
                sendClickedAt: sendClickedAt.toISOString(),
                deliveryConfirmedAt: this.now().toISOString(),
                confirmationStrategy: "VISUAL_OUTGOING_MESSAGE",
                confirmedAffiliateUrl: input.affiliateUrl,
                confirmedTextSnippet: uniqueSnippet(input.title),
                confirmedMedia: Boolean(media.path),
              },
            );
          } finally {
            await media.cleanup();
          }
        },
      );
    } catch (error) {
      const code = sendWasClicked
        ? "WHATSAPP_WEB_DELIVERY_UNCERTAIN"
        : errorCode(error);
      return this.result(
        sendWasClicked ? "DELIVERY_UNCERTAIN" : "FAILED",
        sendWasClicked,
        mediaFallbackUsed,
        code,
        {
          ...baseMetadata,
          deliveryUncertain: sendWasClicked,
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
    });
  }

  private async withConnectedSession<T>(
    profileKey: string,
    operation: (adapter: WhatsAppWebPageAdapter) => Promise<T>,
  ): Promise<T> {
    return new WhatsAppWebSessionManager(
      this.config,
      this.launcher,
      this.profileLock,
    ).withConnectedSession(profileKey, operation);
  }

  private async openExactGroup(adapter: WhatsAppWebPageAdapter, name: string) {
    const located = await adapter.locateGroupExact(name);
    if (located.status !== "GROUP_FOUND") return located;
    await adapter.openGroup(name);
    if (!(await adapter.verifyOpenedGroup(name)))
      throw new Error("WHATSAPP_WEB_GROUP_NOT_FOUND");
    if (!(await adapter.verifyPublishPermission()))
      throw new Error("WHATSAPP_WEB_NO_PUBLISH_PERMISSION");
    return { ...located, publishPermission: true };
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

  private async prepareMedia(input: WhatsAppWebPublicationInput) {
    if (!input.channel.sendImage || !input.imageUrl)
      return { path: null, fallback: false, cleanup: async () => undefined };
    let directory: string | null = null;
    try {
      const image = await (
        this.dependencies.prepareImage ?? prepareRemoteImage
      )(input.imageUrl);
      directory = await mkdtemp(join(tmpdir(), "affiliate-wa-"));
      const path = join(directory, image.filename);
      await writeFile(path, image.bytes);
      return {
        path,
        fallback: false,
        cleanup: async () => rm(directory!, { recursive: true, force: true }),
      };
    } catch {
      if (directory)
        await rm(directory, { recursive: true, force: true }).catch(
          () => undefined,
        );
      if (!this.config.allowTextFallback)
        throw new Error("WHATSAPP_WEB_MEDIA_PREPARATION_FAILED");
      return { path: null, fallback: true, cleanup: async () => undefined };
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
    metadata: Record<string, unknown>,
  ): WhatsAppWebPublishResult {
    return {
      status,
      publicationMode: "WEB_EXPERIMENTAL",
      destinationType: "GROUP",
      sendWasClicked,
      mediaFallbackUsed,
      ...(errorCodeValue ? { errorCode: errorCodeValue } : {}),
      metadata: { ...metadata, sendWasClicked, mediaFallbackUsed },
    };
  }
}

function uniqueSnippet(title: string) {
  return title.replace(/\s+/g, " ").trim().slice(0, 60);
}

function errorCode(error: unknown): WhatsAppWebErrorCode {
  const message = error instanceof Error ? error.message : String(error);
  return /^WHATSAPP_WEB_|^(REDIS_UNAVAILABLE|LOCK_ALREADY_HELD)$/.test(message)
    ? (message as WhatsAppWebErrorCode)
    : "WHATSAPP_WEB_UNEXPECTED_STATE";
}
