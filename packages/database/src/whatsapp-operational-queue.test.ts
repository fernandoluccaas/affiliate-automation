import { describe, expect, it } from "vitest";
import {
  authorizeWhatsAppWebSend,
  buildWhatsAppWebQueueStatus,
  cancelWhatsAppWebPublication,
  claimWhatsAppWebSendAuthorization,
  recordWhatsAppWebPreflight,
  recordWhatsAppWebVisualInspection,
  releaseWhatsAppWebDispatchClaim,
  revokeWhatsAppWebSendAuthorization,
  whatsappWebPublicationFingerprint,
  whatsappWebStoredState,
} from "./whatsapp-operational-queue";

const now = new Date("2026-08-03T12:00:00.000Z");

function channel(configuration: Record<string, unknown> = {}) {
  return {
    id: "channel-web",
    type: "WHATSAPP_GROUPS",
    enabled: true,
    configuration: {
      publicationMode: "WEB_EXPERIMENTAL",
      webAutomationEnabled: true,
      webAutomationOwnershipConfirmed: true,
      webAutomationConfirmedAt: "2026-08-03T10:00:00.000Z",
      ...configuration,
    },
  } as never;
}

function publication(
  id: string,
  plannedAt: string,
  metadata: Record<string, unknown> = {},
  status = "SCHEDULED",
) {
  return {
    id,
    offerId: `offer-${id}`,
    channelId: "channel-web",
    status,
    scheduledAt: new Date(plannedAt),
    createdAt: new Date(plannedAt),
    updatedAt: new Date(plannedAt),
    metadata: {
      publicationMode: "WEB_EXPERIMENTAL",
      whatsappWebState: "AWAITING_VISUAL_INSPECTION",
      plannedAt,
      ...metadata,
    },
    messagePayload: { message: `safe-${id}` },
    imageUrlSnapshot: null,
    affiliateUrlSnapshot: "https://meli.la/safe",
    trackingUrlSnapshot: "https://meli.la/safe",
    offerVersionSnapshot: 1,
    currentPriceSnapshot: 10,
  } as never;
}

describe("WhatsApp Web operational queue", () => {
  it("makes the oldest Publication active and blocks the second and third", () => {
    const queue = buildWhatsAppWebQueueStatus(channel(), [
      publication("third", "2026-08-03T11:00:00.000Z"),
      publication("first", "2026-08-03T09:00:00.000Z"),
      publication("second", "2026-08-03T10:00:00.000Z"),
    ], now);

    expect(queue).toMatchObject({
      activePublicationId: "first",
      waitingCount: 2,
      total: 3,
      queueBlocked: true,
    });
    expect(queue.items.map((item) => [item.publicationId, item.effectiveState])).toEqual([
      ["first", "AWAITING_VISUAL_INSPECTION"],
      ["second", "BLOCKED_BY_ACTIVE_PUBLICATION"],
      ["third", "BLOCKED_BY_ACTIVE_PUBLICATION"],
    ]);
  });

  it("promotes the next Publication after cancellation without changing snapshots", () => {
    const cancelled = publication(
      "first",
      "2026-08-03T09:00:00.000Z",
      { whatsappWebState: "CANCELLED", cancelledAt: now.toISOString() },
      "CANCELLED",
    );
    const next = publication("second", "2026-08-03T10:00:00.000Z");
    const queue = buildWhatsAppWebQueueStatus(channel(), [cancelled, next], now);

    expect(queue.activePublicationId).toBe("second");
    expect(queue.cancelledCount).toBe(1);
    expect(queue.items.find((item) => item.publicationId === "first")?.position).toBeNull();
  });

  it("prioritizes unresolved DELIVERY_UNCERTAIN and blocks the channel", () => {
    const queue = buildWhatsAppWebQueueStatus(channel(), [
      publication("oldest", "2026-08-03T09:00:00.000Z"),
      publication("uncertain", "2026-08-03T10:00:00.000Z", {
        deliveryUncertain: true,
        sendClickStartedAt: "2026-08-03T10:01:00.000Z",
      }),
    ], now);

    expect(queue).toMatchObject({
      activePublicationId: "uncertain",
      activeState: "DELIVERY_UNCERTAIN",
      deliveryUncertainCount: 1,
      queueBlocked: true,
    });
  });

  it("releases the next item after final NOT_DELIVERED reconciliation", () => {
    const queue = buildWhatsAppWebQueueStatus(channel(), [
      publication("resolved", "2026-08-03T09:00:00.000Z", {
        deliveryUncertain: false,
        manualDeliveryResolution: "MANUALLY_CONFIRMED_NOT_DELIVERED",
      }, "PUBLICATION_FAILED"),
      publication("next", "2026-08-03T10:00:00.000Z"),
    ], now);

    expect(queue.activePublicationId).toBe("next");
    expect(queue.deliveryUncertainCount).toBe(0);
  });

  it("derives active and expired unitary authorizations", () => {
    expect(
      whatsappWebStoredState(
        publication("active", "2026-08-03T09:00:00.000Z", {
          sendAuthorizationStatus: "ACTIVE",
          sendAuthorizationExpiresAt: "2026-08-03T12:15:00.000Z",
        }),
        now,
      ),
    ).toBe("AUTHORIZED_FOR_SEND");
    expect(
      whatsappWebStoredState(
        publication("expired", "2026-08-03T09:00:00.000Z", {
          sendAuthorizationStatus: "ACTIVE",
          sendAuthorizationExpiresAt: "2026-08-03T11:59:00.000Z",
        }),
        now,
      ),
    ).toBe("AUTHORIZATION_EXPIRED");
  });

  it("keeps fingerprints stable and invalidates them after relevant configuration changes", () => {
    const item = publication("fingerprint", "2026-08-03T09:00:00.000Z");
    const first = whatsappWebPublicationFingerprint({
      publication: item,
      channel: channel(),
    });
    const same = whatsappWebPublicationFingerprint({
      publication: item,
      channel: channel(),
    });
    const changed = whatsappWebPublicationFingerprint({
      publication: item,
      channel: channel({ webAutomationPaused: true }),
    });

    expect(first).toBe(same);
    expect(changed).not.toBe(first);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });
});

function operationalDatabase() {
  const storedChannel = channel() as Record<string, unknown>;
  const publications = [
    publication("first", "2026-08-03T09:00:00.000Z"),
    publication("second", "2026-08-03T10:00:00.000Z"),
  ] as Array<Record<string, unknown>>;
  let transactionTail = Promise.resolve();
  const transactionClient = {
    $queryRaw: async () => [{ id: "channel-web" }],
    channel: {
      findUnique: async () => storedChannel,
    },
    publication: {
      findMany: async () => publications,
      findUnique: async ({ where }: { where: { id: string } }) => {
        const stored = publications.find((item) => item.id === where.id);
        return stored ? { ...stored, channel: storedChannel } : null;
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const stored = publications.find((item) => item.id === where.id);
        if (!stored) throw new Error("PUBLICATION_NOT_FOUND");
        Object.assign(stored, data);
        return stored;
      },
    },
  };
  const client = {
    ...transactionClient,
    $transaction: async <T>(callback: (tx: unknown) => Promise<T>) => {
      let release: () => void = () => undefined;
      const previous = transactionTail;
      transactionTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await callback(transactionClient);
      } finally {
        release();
      }
    },
  };
  return { client: client as never, publications };
}

describe("WhatsApp Web controlled operations", () => {
  it("confirms inspection, preflights, authorizes once and revokes without browser", async () => {
    const database = operationalDatabase();
    const inspected = await recordWhatsAppWebVisualInspection(database.client, {
      publicationId: "first",
      confirmed: true,
      actorId: "owner",
      result: { visualDraftInspectionFingerprint: "publisher-fingerprint" },
      now,
    });
    expect(inspected).toMatchObject({
      state: "VISUAL_INSPECTION_CONFIRMED",
      sendCalled: false,
    });

    const preflight = await recordWhatsAppWebPreflight(database.client, {
      publicationId: "first",
      ready: true,
      actorId: "owner",
      result: { status: "READY_TO_COMMIT_SEND" },
      now,
    });
    expect(preflight.state).toBe("PREFLIGHT_READY");

    const [authorized, repeated] = await Promise.all([
      authorizeWhatsAppWebSend(database.client, {
        publicationId: "first",
        actorId: "owner",
        expiresInMinutes: 15,
        now,
      }),
      authorizeWhatsAppWebSend(database.client, {
        publicationId: "first",
        actorId: "owner",
        expiresInMinutes: 15,
        now,
      }),
    ]);
    expect(authorized.authorizationId).toBe(repeated.authorizationId);
    expect([authorized.idempotent, repeated.idempotent]).toContain(true);
    expect(authorized).toMatchObject({ browserOpened: false, sendCalled: false });

    const revoked = await revokeWhatsAppWebSendAuthorization(database.client, {
      publicationId: "first",
      actorId: "owner",
      reason: "safe test revocation",
      now,
    });
    expect(revoked).toMatchObject({
      state: "PREFLIGHT_READY",
      browserOpened: false,
      sendCalled: false,
    });
  });

  it("claims an authorization atomically and refuses a second claim", async () => {
    const database = operationalDatabase();
    await recordWhatsAppWebVisualInspection(database.client, {
      publicationId: "first",
      confirmed: true,
      actorId: "owner",
      result: { visualDraftInspectionFingerprint: "publisher-fingerprint" },
      now,
    });
    await recordWhatsAppWebPreflight(database.client, {
      publicationId: "first",
      ready: true,
      actorId: "owner",
      result: { status: "READY_TO_COMMIT_SEND" },
      now,
    });
    await authorizeWhatsAppWebSend(database.client, {
      publicationId: "first",
      actorId: "owner",
      expiresInMinutes: 15,
      now,
    });

    await expect(
      claimWhatsAppWebSendAuthorization(database.client, {
        publicationId: "first",
        actorId: "publisher",
        now,
      }),
    ).resolves.toMatchObject({
      publicationId: "first",
      channelId: "channel-web",
      claimId: expect.any(String),
    });
    await expect(
      claimWhatsAppWebSendAuthorization(database.client, {
        publicationId: "first",
        actorId: "publisher-2",
        now,
      }),
    ).rejects.toThrow("WHATSAPP_WEB_SEND_AUTHORIZATION_ALREADY_CONSUMED");
  });

  it("releases an abandoned claim only before the send marker", async () => {
    const database = operationalDatabase();
    await recordWhatsAppWebVisualInspection(database.client, {
      publicationId: "first",
      confirmed: true,
      actorId: "owner",
      result: { visualDraftInspectionFingerprint: "publisher-fingerprint" },
      now,
    });
    await recordWhatsAppWebPreflight(database.client, {
      publicationId: "first",
      ready: true,
      actorId: "owner",
      result: { status: "READY_TO_COMMIT_SEND" },
      now,
    });
    await authorizeWhatsAppWebSend(database.client, {
      publicationId: "first",
      actorId: "owner",
      expiresInMinutes: 15,
      now,
    });
    await claimWhatsAppWebSendAuthorization(database.client, {
      publicationId: "first",
      actorId: "dispatcher",
      now,
    });
    await expect(
      releaseWhatsAppWebDispatchClaim(database.client, {
        publicationId: "first",
        actorId: "owner",
        reason: "process ended before browser",
        now,
      }),
    ).resolves.toMatchObject({
      state: "REAUTHORIZE_REQUIRED",
      browserOpened: false,
      sendCalled: false,
    });

    const metadata = database.publications[0]?.metadata as Record<string, unknown>;
    metadata.sendAuthorizationStatus = "CLAIMED";
    metadata.sendClickStartedAt = now.toISOString();
    await expect(
      releaseWhatsAppWebDispatchClaim(database.client, {
        publicationId: "first",
        actorId: "owner",
        reason: "unsafe release",
        now,
      }),
    ).rejects.toThrow("WHATSAPP_WEB_DISPATCH_CLAIM_RELEASE_FORBIDDEN_AFTER_CLICK");
  });

  it("cancels a waiting Publication idempotently and preserves its snapshot", async () => {
    const database = operationalDatabase();
    const before = database.publications[1]?.messagePayload;
    const cancelled = await cancelWhatsAppWebPublication(database.client, {
      publicationId: "second",
      actorId: "owner",
      reason: "duplicate backlog",
      now,
    });
    const repeated = await cancelWhatsAppWebPublication(database.client, {
      publicationId: "second",
      actorId: "owner",
      reason: "duplicate backlog",
      now,
    });

    expect(cancelled).toMatchObject({
      state: "CANCELLED",
      idempotent: false,
      browserOpened: false,
      sendCalled: false,
    });
    expect(repeated.idempotent).toBe(true);
    expect(database.publications[1]?.messagePayload).toEqual(before);
  });
});
