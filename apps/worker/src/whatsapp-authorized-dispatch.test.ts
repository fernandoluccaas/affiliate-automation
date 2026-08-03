import { describe, expect, it, vi } from "vitest";
import {
  whatsappWebConfigurationFingerprint,
  whatsappWebVisualDraftInspectionFingerprint,
  type WhatsAppWebPublishResult,
  type WhatsAppWebRuntimeConfig,
} from "@affiliate/publisher-connectors";
import type { LockHandle } from "@affiliate/redis";
import {
  dispatchAuthorizedWhatsAppPublication,
  type AuthorizedDispatchContext,
  type AuthorizedDispatchDependencies,
} from "./whatsapp-authorized-dispatch";

function lock(acquired = true): LockHandle {
  return {
    key: "safe-lock",
    token: "safe-token",
    acquired,
    mode: "redis-url",
    ...(acquired ? {} : { failureReason: "LOCK_ALREADY_HELD" as const }),
    extend: vi.fn(async () => true),
    release: vi.fn(async () => undefined),
  };
}

const config: WhatsAppWebRuntimeConfig = {
  enabled: true,
  dryRun: false,
  headless: true,
  userDataRoot: ".local/test",
  debugRoot: ".local/test-debug",
  debugScreenshots: false,
  actionTimeoutMs: 1_000,
  navigationTimeoutMs: 1_000,
  confirmationTimeoutMs: 1_000,
  profileLockTtlMs: 30_000,
  maxPublicationsPerRun: 1,
  autoPauseAfterFirstSuccess: true,
  allowTextFallback: true,
  slowMoMs: 0,
  keepOpenOnError: false,
  keepOpenOnErrorTimeoutMs: 1_000,
};

function context(
  metadataPatch: Record<string, unknown> = {},
  status = "SCHEDULED",
): AuthorizedDispatchContext {
  const channel = {
    channelId: "channel-web",
    channelType: "WHATSAPP_GROUPS",
    channelEnabled: true,
    channelPaused: false,
    publicationMode: "WEB_EXPERIMENTAL",
    groupDisplayName: "configured-group",
    webProfileKey: "principal",
    webAutomationEnabled: true,
    webAutomationOwnershipConfirmed: true,
    webAutomationConfirmedAt: "2026-08-03T10:00:00.000Z",
    sendImage: true,
    lastSuccessfulDryRunAt: "2026-08-03T10:10:00.000Z",
    lastSuccessfulDryRunConfigurationFingerprint: "",
  };
  channel.lastSuccessfulDryRunConfigurationFingerprint =
    whatsappWebConfigurationFingerprint(channel);
  const message = "Oferta segura https://meli.la/safe";
  const imageUrl = "https://images.example.test/safe.jpg";
  const visualFingerprint = whatsappWebVisualDraftInspectionFingerprint({
    channel,
    messageSnapshot: message,
    imageSnapshot: imageUrl,
  });
  const fingerprint = "a".repeat(64);
  const metadata = {
    publicationMode: "WEB_EXPERIMENTAL",
    whatsappWebState: "AUTHORIZED_FOR_SEND",
    visualDraftInspectionConfirmed: true,
    lastVisualDraftInspectionFingerprint: visualFingerprint,
    preflightCompleted: true,
    preflightFingerprint: fingerprint,
    sendAuthorizationStatus: "ACTIVE",
    sendAuthorizationId: "authorization-one",
    sendAuthorizationPublicationId: "publication-one",
    sendAuthorizationChannelId: "channel-web",
    sendAuthorizationFingerprint: fingerprint,
    sendAuthorizationExpiresAt: "2099-08-03T12:15:00.000Z",
    ...metadataPatch,
  };
  return {
    publication: {
      id: "publication-one",
      offerId: "offer-one",
      channelId: "channel-web",
      status,
      metadata,
    },
    input: {
      publicationId: "publication-one",
      offerId: "offer-one",
      destinationType: "GROUP",
      message,
      affiliateUrl: "https://meli.la/safe",
      title: "Oferta segura",
      currentPrice: "10.00",
      imageUrl,
      publicationStatus: status,
      publicationMetadata: metadata,
      channel,
    },
    fingerprint,
  };
}

function published(): WhatsAppWebPublishResult {
  return {
    status: "PUBLISHED",
    publicationMode: "WEB_EXPERIMENTAL",
    destinationType: "GROUP",
    sendWasClicked: true,
    mediaFallbackUsed: false,
    stage: "DELIVERY_CONFIRMED",
    rootCause: "DELIVERY_CONFIRMED",
    deliveryUncertain: false,
    deliveryConfirmed: true,
    metadata: { deliveryConfirmedAt: "2026-08-03T12:01:00.000Z" },
  };
}

function dependencies(
  overrides: Partial<AuthorizedDispatchDependencies> = {},
) {
  const calls: string[] = [];
  const events: Array<Record<string, unknown>> = [];
  const deps: AuthorizedDispatchDependencies = {
    config,
    loadContext: vi.fn(async () => context()),
    acquireOperationalLock: vi.fn(async () => {
      calls.push("operational-lock");
      return lock();
    }),
    claim: vi.fn(async () => {
      calls.push("claim");
      return { claimId: "claim-1234567890", channelId: "channel-web" };
    }),
    acquireProfileLock: vi.fn(async () => {
      calls.push("profile-lock");
      return lock();
    }),
    acquirePublicationLock: vi.fn(async () => {
      calls.push("publication-lock");
      return lock();
    }),
    createPublisher: vi.fn((_profileLock, recordState) => ({
      publish: vi.fn(async () => {
        calls.push("publisher");
        await recordState({
          publicationId: "publication-one",
          stage: "SEND_CLICK_STARTED",
          sendWasClicked: false,
          sendClickStartedAt: "2026-08-03T12:00:00.000Z",
          deliveryUncertain: true,
        });
        await recordState({
          publicationId: "publication-one",
          stage: "SEND_CLICK_COMPLETED",
          sendWasClicked: true,
          sendClickStartedAt: "2026-08-03T12:00:00.000Z",
          sendClickedAt: "2026-08-03T12:00:01.000Z",
          deliveryUncertain: true,
        });
        return published();
      }),
    }) as never),
    createAttempt: vi.fn(async () => "attempt-one"),
    finishAttempt: vi.fn(async () => undefined),
    recordSendState: vi.fn(async () => undefined),
    finalize: vi.fn(async () => undefined),
    emit: vi.fn((event) => events.push(event)),
    ...overrides,
  };
  return { deps, calls, events };
}

describe("controlled WhatsApp authorized dispatch", () => {
  it("rejects dry-run before lock, claim, browser and send", async () => {
    const fixture = dependencies({ config: { ...config, dryRun: true } });
    const result = await dispatchAuthorizedWhatsAppPublication(
      { publicationId: "publication-one", confirmSend: true },
      fixture.deps,
    );

    expect(result).toMatchObject({
      status: "FAILED",
      errorCode: "WHATSAPP_WEB_REAL_SEND_DISABLED_BY_DRY_RUN",
      authorizationClaimed: false,
      authorizationConsumed: false,
      browserOpened: false,
      sendCalled: false,
    });
    expect(fixture.deps.acquireOperationalLock).not.toHaveBeenCalled();
    expect(fixture.deps.claim).not.toHaveBeenCalled();
    expect(fixture.deps.createPublisher).not.toHaveBeenCalled();
  });

  it("requires the explicit --confirm-send equivalent before claiming", async () => {
    const fixture = dependencies();
    const result = await dispatchAuthorizedWhatsAppPublication(
      { publicationId: "publication-one", confirmSend: false },
      fixture.deps,
    );
    expect(result.errorCode).toBe("WHATSAPP_WEB_CONFIRM_SEND_REQUIRED");
    expect(fixture.deps.claim).not.toHaveBeenCalled();
  });

  it.each([
    ["paused channel", { input: { channel: { channelPaused: true } } }, "WHATSAPP_WEB_CHANNEL_PAUSED"],
    ["revoked authorization", { metadata: { sendAuthorizationStatus: "REVOKED" } }, "WHATSAPP_WEB_SEND_AUTHORIZATION_REVOKED"],
    ["consumed authorization", { metadata: { sendAuthorizationStatus: "CONSUMED" } }, "WHATSAPP_WEB_SEND_AUTHORIZATION_ALREADY_CONSUMED"],
    ["expired authorization", { metadata: { sendAuthorizationExpiresAt: "2020-01-01T00:00:00.000Z" } }, "WHATSAPP_WEB_SEND_AUTHORIZATION_EXPIRED"],
    ["fingerprint mismatch", { metadata: { sendAuthorizationFingerprint: "b".repeat(64) } }, "WHATSAPP_WEB_SEND_AUTHORIZATION_FINGERPRINT_MISMATCH"],
    ["preflight mismatch", { metadata: { preflightFingerprint: "b".repeat(64) } }, "WHATSAPP_WEB_PREFLIGHT_REQUIRED"],
  ])("rejects %s without browser", async (_label, patch, expected) => {
    const base = context();
    const metadataPatch = "metadata" in patch ? patch.metadata : undefined;
    const channelPatch = "input" in patch ? patch.input?.channel : undefined;
    const changed = context(metadataPatch);
    changed.input.channel = { ...base.input.channel, ...channelPatch };
    const fixture = dependencies({ loadContext: vi.fn(async () => changed) });
    const result = await dispatchAuthorizedWhatsAppPublication(
      { publicationId: "publication-one", confirmSend: true },
      fixture.deps,
    );
    expect(result.errorCode).toBe(expected);
    expect(fixture.deps.claim).not.toHaveBeenCalled();
    expect(fixture.deps.createPublisher).not.toHaveBeenCalled();
  });

  it("takes operational, profile and publication locks in order before publisher", async () => {
    const fixture = dependencies();
    const result = await dispatchAuthorizedWhatsAppPublication(
      { publicationId: "publication-one", confirmSend: true },
      fixture.deps,
    );
    expect(result.status).toBe("PUBLISHED");
    expect(fixture.calls).toEqual([
      "operational-lock",
      "claim",
      "profile-lock",
      "publication-lock",
      "publisher",
    ]);
    expect(fixture.deps.createAttempt).toHaveBeenCalledTimes(1);
    expect(fixture.deps.finalize).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "PUBLISHED" }),
    );
  });

  it("allows only one concurrent dispatch to reach the atomic claim", async () => {
    let held = false;
    const acquireOperationalLock = vi.fn(async () => {
      if (held) return lock(false);
      held = true;
      const handle = lock();
      handle.release = vi.fn(async () => {
        held = false;
      });
      return handle;
    });
    const fixture = dependencies({ acquireOperationalLock });
    let releasePublisher!: () => void;
    const publisherWait = new Promise<void>((resolve) => {
      releasePublisher = resolve;
    });
    fixture.deps.createPublisher = vi.fn(() => ({
      publish: vi.fn(async () => {
        await publisherWait;
        return {
          ...published(),
          status: "FAILED",
          errorCode: "WHATSAPP_WEB_SELECTOR_MISMATCH",
          sendWasClicked: false,
          deliveryUncertain: false,
        };
      }),
    }) as never);

    const first = dispatchAuthorizedWhatsAppPublication(
      { publicationId: "publication-one", confirmSend: true },
      fixture.deps,
    );
    await vi.waitFor(() => expect(fixture.deps.claim).toHaveBeenCalledTimes(1));
    const second = await dispatchAuthorizedWhatsAppPublication(
      { publicationId: "publication-one", confirmSend: true },
      fixture.deps,
    );
    releasePublisher();
    await first;

    expect(second.errorCode).toBe("WHATSAPP_WEB_CHANNEL_DISPATCH_IN_PROGRESS");
    expect(fixture.deps.claim).toHaveBeenCalledTimes(1);
    expect(fixture.deps.createAttempt).toHaveBeenCalledTimes(1);
  });

  it("classifies an inconclusive confirmation as DELIVERY_UNCERTAIN", async () => {
    const fixture = dependencies({
      createPublisher: vi.fn((_lock, recordState) => ({
        publish: vi.fn(async () => {
          await recordState({
            publicationId: "publication-one",
            stage: "SEND_CLICK_STARTED",
            sendWasClicked: false,
            sendClickStartedAt: "2026-08-03T12:00:00.000Z",
            deliveryUncertain: true,
          });
          return {
            ...published(),
            status: "DELIVERY_UNCERTAIN",
            errorCode: "WHATSAPP_WEB_DELIVERY_UNCERTAIN",
            sendWasClicked: true,
            deliveryUncertain: true,
          };
        }),
      }) as never),
    });
    const result = await dispatchAuthorizedWhatsAppPublication(
      { publicationId: "publication-one", confirmSend: true },
      fixture.deps,
    );
    expect(result.status).toBe("DELIVERY_UNCERTAIN");
    expect(fixture.deps.finalize).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "DELIVERY_UNCERTAIN" }),
    );
  });

  it("fails safe before click and requires new preflight", async () => {
    const fixture = dependencies({
      createPublisher: vi.fn(() => ({
        publish: vi.fn(async () => ({
          ...published(),
          status: "FAILED",
          errorCode: "WHATSAPP_WEB_SELECTOR_MISMATCH",
          sendWasClicked: false,
          deliveryUncertain: false,
        })),
      }) as never),
    });
    const result = await dispatchAuthorizedWhatsAppPublication(
      { publicationId: "publication-one", confirmSend: true },
      fixture.deps,
    );
    expect(result.status).toBe("FAILED");
    expect(fixture.deps.finalize).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "FAILED_BEFORE_CLICK" }),
    );
  });

  it("fails safe when the mandatory pre-click marker cannot be persisted", async () => {
    const fixture = dependencies({
      recordSendState: vi.fn(async () => {
        throw new Error("WHATSAPP_WEB_SEND_STATE_PERSIST_FAILED");
      }),
    });
    const result = await dispatchAuthorizedWhatsAppPublication(
      { publicationId: "publication-one", confirmSend: true },
      fixture.deps,
    );
    expect(result).toMatchObject({
      status: "FAILED",
      errorCode: "WHATSAPP_WEB_SEND_STATE_PERSIST_FAILED",
      sendCalled: false,
    });
    expect(fixture.deps.finalize).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "FAILED_BEFORE_CLICK" }),
    );
  });

  it("marks a crash after the persisted click boundary as uncertain", async () => {
    let writes = 0;
    const fixture = dependencies({
      recordSendState: vi.fn(async () => {
        writes += 1;
        if (writes === 2) {
          throw new Error("WHATSAPP_WEB_SEND_STATE_PERSIST_FAILED");
        }
      }),
    });
    const result = await dispatchAuthorizedWhatsAppPublication(
      { publicationId: "publication-one", confirmSend: true },
      fixture.deps,
    );
    expect(result.status).toBe("DELIVERY_UNCERTAIN");
    expect(fixture.deps.finalize).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "DELIVERY_UNCERTAIN" }),
    );
  });

  it("returns published idempotently without locks, attempts or browser", async () => {
    const fixture = dependencies({
      loadContext: vi.fn(async () => context({}, "PUBLISHED")),
    });
    const result = await dispatchAuthorizedWhatsAppPublication(
      { publicationId: "publication-one", confirmSend: true },
      fixture.deps,
    );
    expect(result).toMatchObject({ status: "SKIPPED", browserOpened: false });
    expect(fixture.deps.acquireOperationalLock).not.toHaveBeenCalled();
    expect(fixture.deps.createAttempt).not.toHaveBeenCalled();
  });

  it("emits only sanitized operational data", async () => {
    const fixture = dependencies({ config: { ...config, dryRun: true } });
    await dispatchAuthorizedWhatsAppPublication(
      { publicationId: "publication-one", confirmSend: true },
      fixture.deps,
    );
    const serialized = JSON.stringify(fixture.events);
    expect(serialized).not.toContain("configured-group");
    expect(serialized).not.toContain("meli.la");
    expect(serialized).not.toContain("Oferta segura");
    expect(serialized).not.toContain("principal");
  });
});
