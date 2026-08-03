import { describe, expect, it, vi } from "vitest";
import {
  authorizeWhatsAppWebRetry,
  buildWhatsAppManualDeliveryResolution,
  resolveWhatsAppWebDelivery,
} from "./whatsapp-delivery-resolution";

const automatic = {
  stage: "DELIVERY_CONFIRMATION_TIMEOUT",
  rootCause: "DELIVERY_CONFIRMATION_TIMEOUT",
  sendClickStartedAt: "2026-08-03T02:28:30.629Z",
  sendWasClicked: true,
  sendClickedAt: "2026-08-03T02:28:31.736Z",
  deliveryUncertain: true,
  retryAuthorized: false,
};

describe("manual WhatsApp delivery resolution", () => {
  it("marks delivered while preserving the original click and error audit", () => {
    const result = buildWhatsAppManualDeliveryResolution({
      metadata: automatic,
      decision: "DELIVERED",
      actorId: "user-1",
      resolvedAt: new Date("2026-08-03T03:00:00.000Z"),
      reason: "Visual confirmation",
      originalErrorCode: "WHATSAPP_WEB_DELIVERY_UNCERTAIN",
    });
    expect(result).toMatchObject({
      manualDeliveryResolution: "MANUALLY_CONFIRMED_DELIVERED",
      deliveryConfirmed: true,
      deliveryUncertain: false,
      retryAuthorized: false,
      sendClickStartedAt: automatic.sendClickStartedAt,
      sendClickedAt: automatic.sendClickedAt,
      originalDeliveryErrorCode: "WHATSAPP_WEB_DELIVERY_UNCERTAIN",
    });
  });

  it("marks not delivered without authorizing a retry", () => {
    const result = buildWhatsAppManualDeliveryResolution({
      metadata: automatic,
      decision: "NOT_DELIVERED",
      actorId: "user-1",
      resolvedAt: new Date("2026-08-03T03:00:00.000Z"),
    });
    expect(result).toMatchObject({
      manualDeliveryResolution: "MANUALLY_CONFIRMED_NOT_DELIVERED",
      deliveryConfirmed: false,
      deliveryUncertain: false,
      retryAuthorized: false,
    });
  });

  it("keeps an inconclusive attempt blocked", () => {
    const result = buildWhatsAppManualDeliveryResolution({
      metadata: automatic,
      decision: "KEEP_UNCERTAIN",
      actorId: "user-1",
      resolvedAt: new Date("2026-08-03T03:00:00.000Z"),
    });
    expect(result).toMatchObject({
      manualDeliveryResolution: "MANUALLY_KEPT_UNCERTAIN",
      deliveryUncertain: true,
      retryAuthorized: false,
    });
  });

  it("preserves the original attempt, pauses after delivered, and is idempotent", async () => {
    const publication = {
      id: "publication-1",
      offerId: "offer-1",
      channelId: "channel-1",
      status: "PUBLICATION_FAILED",
      errorMessage: "WHATSAPP_WEB_DELIVERY_UNCERTAIN",
      publishedAt: null,
      metadata: automatic as Record<string, unknown>,
      attempts: [{ id: "attempt-1" }],
      channel: { configuration: { webAutomationPaused: false } },
    };
    const tx = {
      publication: {
        findUnique: vi.fn().mockResolvedValue(publication),
        update: vi.fn().mockResolvedValue(undefined),
      },
      offer: { update: vi.fn().mockResolvedValue(undefined) },
      channel: { update: vi.fn().mockResolvedValue(undefined) },
    };
    const client = {
      $transaction: vi.fn(async (operation: (value: typeof tx) => unknown) =>
        operation(tx),
      ),
    };
    const result = await resolveWhatsAppWebDelivery(client as never, {
      publicationId: publication.id,
      decision: "DELIVERED",
      actorId: "user-1",
      reason: "Confirmed visually",
      autoPauseAfterFirstSuccess: true,
      now: new Date("2026-08-03T03:00:00.000Z"),
    });
    expect(result).toMatchObject({
      status: "PUBLISHED",
      attemptCount: 1,
      retryAuthorized: false,
    });
    expect(tx.channel.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          configuration: expect.objectContaining({
            webAutomationPaused: true,
          }),
        },
      }),
    );
    expect(tx.publication.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: expect.objectContaining({
            sendClickStartedAt: automatic.sendClickStartedAt,
          }),
        }),
      }),
    );

    publication.status = "PUBLISHED";
    publication.metadata = {
      ...automatic,
      deliveryUncertain: false,
      manualDeliveryResolution: "MANUALLY_CONFIRMED_DELIVERED",
    };
    const repeated = await resolveWhatsAppWebDelivery(client as never, {
      publicationId: publication.id,
      decision: "DELIVERED",
      actorId: "user-1",
      autoPauseAfterFirstSuccess: true,
    });
    expect(repeated.idempotent).toBe(true);
    expect(tx.publication.update).toHaveBeenCalledTimes(1);
  });

  it("blocks a second send until retry receives a separate explicit review", async () => {
    const tx = {
      publication: {
        findUnique: vi.fn().mockResolvedValue({
          id: "publication-1",
          metadata: automatic,
        }),
        update: vi.fn(),
      },
    };
    const client = {
      $transaction: vi.fn(async (operation: (value: typeof tx) => unknown) =>
        operation(tx),
      ),
    };
    await expect(
      authorizeWhatsAppWebRetry(client as never, {
        publicationId: "publication-1",
        actorId: "user-1",
      }),
    ).rejects.toThrow("WHATSAPP_WEB_RETRY_REVIEW_REQUIRED");
    expect(tx.publication.update).not.toHaveBeenCalled();
  });
});
