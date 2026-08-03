import type { Prisma, PrismaClient } from "@prisma/client";

export type WhatsAppManualDeliveryDecision =
  "DELIVERED" | "NOT_DELIVERED" | "KEEP_UNCERTAIN";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function buildWhatsAppManualDeliveryResolution(input: {
  metadata: unknown;
  decision: WhatsAppManualDeliveryDecision;
  actorId: string;
  resolvedAt: Date;
  reason?: string | null;
  originalErrorCode?: string | null;
}) {
  const metadata = record(input.metadata);
  const resolvedAt = input.resolvedAt.toISOString();
  const resolution =
    input.decision === "DELIVERED"
      ? "MANUALLY_CONFIRMED_DELIVERED"
      : input.decision === "NOT_DELIVERED"
        ? "MANUALLY_CONFIRMED_NOT_DELIVERED"
        : "MANUALLY_KEPT_UNCERTAIN";
  return {
    ...metadata,
    originalDeliveryErrorCode:
      typeof metadata.originalDeliveryErrorCode === "string"
        ? metadata.originalDeliveryErrorCode
        : input.originalErrorCode || "WHATSAPP_WEB_DELIVERY_UNCERTAIN",
    manualDeliveryResolution: resolution,
    manualDeliveryResolvedAt: resolvedAt,
    manualDeliveryResolvedBy: input.actorId,
    manualDeliveryResolutionReason: input.reason?.trim() || null,
    deliveryConfirmed: input.decision === "DELIVERED",
    deliveryConfirmedAt:
      input.decision === "DELIVERED"
        ? typeof metadata.deliveryConfirmedAt === "string"
          ? metadata.deliveryConfirmedAt
          : resolvedAt
        : null,
    deliveryUncertain: input.decision === "KEEP_UNCERTAIN",
    retryAuthorized: false,
  };
}

export async function resolveWhatsAppWebDelivery(
  client: PrismaClient,
  input: {
    publicationId: string;
    decision: WhatsAppManualDeliveryDecision;
    actorId: string;
    reason?: string | null;
    autoPauseAfterFirstSuccess: boolean;
    now?: Date;
  },
) {
  if (!input.actorId.trim()) throw new Error("AUTHENTICATED_ACTOR_REQUIRED");
  if ((input.reason?.length ?? 0) > 500)
    throw new Error("DELIVERY_RESOLUTION_REASON_TOO_LONG");
  const now = input.now ?? new Date();
  return client.$transaction(async (tx) => {
    const publication = await tx.publication.findUnique({
      where: { id: input.publicationId },
      include: {
        attempts: { select: { id: true } },
        channel: { select: { configuration: true } },
      },
    });
    if (!publication) throw new Error("PUBLICATION_NOT_FOUND");
    const currentMetadata = record(publication.metadata);
    const resolution = currentMetadata.manualDeliveryResolution;
    if (
      input.decision === "DELIVERED" &&
      publication.status === "PUBLISHED" &&
      resolution === "MANUALLY_CONFIRMED_DELIVERED"
    ) {
      return {
        status: "PUBLISHED" as const,
        resolution,
        deliveryConfirmed: true,
        deliveryUncertain: false,
        retryAuthorized: false,
        attemptCount: publication.attempts.length,
        idempotent: true,
      };
    }
    if (
      currentMetadata.deliveryUncertain !== true ||
      publication.errorMessage !== "WHATSAPP_WEB_DELIVERY_UNCERTAIN"
    ) {
      throw new Error("DELIVERY_UNCERTAIN_NOT_FOUND");
    }
    const metadata = buildWhatsAppManualDeliveryResolution({
      metadata: currentMetadata,
      decision: input.decision,
      actorId: input.actorId,
      resolvedAt: now,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      originalErrorCode: publication.errorMessage,
    });
    const status =
      input.decision === "DELIVERED"
        ? ("PUBLISHED" as const)
        : ("PUBLICATION_FAILED" as const);
    await tx.publication.update({
      where: { id: publication.id },
      data: {
        status,
        publishedAt:
          input.decision === "DELIVERED"
            ? (publication.publishedAt ?? now)
            : publication.publishedAt,
        metadata: metadata as Prisma.InputJsonValue,
      },
    });
    if (input.decision === "DELIVERED") {
      await tx.offer.update({
        where: { id: publication.offerId },
        data: { status: "PUBLISHED", publishedAt: now },
      });
      if (input.autoPauseAfterFirstSuccess) {
        await tx.channel.update({
          where: { id: publication.channelId },
          data: {
            configuration: {
              ...record(publication.channel.configuration),
              webAutomationPaused: true,
              webAutomationPauseReason:
                "WHATSAPP_WEB_FIRST_SUCCESS_REVIEW_REQUIRED",
              webLastSuccessAt: now.toISOString(),
            } as Prisma.InputJsonValue,
          },
        });
      }
    }
    return {
      status,
      resolution: metadata.manualDeliveryResolution,
      deliveryConfirmed: metadata.deliveryConfirmed,
      deliveryUncertain: metadata.deliveryUncertain,
      retryAuthorized: false,
      attemptCount: publication.attempts.length,
      idempotent: false,
    };
  });
}

export async function authorizeWhatsAppWebRetry(
  client: PrismaClient,
  input: { publicationId: string; actorId: string; now?: Date },
) {
  if (!input.actorId.trim()) throw new Error("AUTHENTICATED_ACTOR_REQUIRED");
  const now = input.now ?? new Date();
  return client.$transaction(async (tx) => {
    const publication = await tx.publication.findUnique({
      where: { id: input.publicationId },
    });
    if (!publication) throw new Error("PUBLICATION_NOT_FOUND");
    const metadata = record(publication.metadata);
    if (
      metadata.manualDeliveryResolution !==
        "MANUALLY_CONFIRMED_NOT_DELIVERED" ||
      metadata.deliveryUncertain === true ||
      metadata.retryAuthorized === true
    ) {
      throw new Error("WHATSAPP_WEB_RETRY_REVIEW_REQUIRED");
    }
    await tx.publication.update({
      where: { id: publication.id },
      data: {
        status: "SCHEDULED",
        scheduledAt: now,
        metadata: {
          ...metadata,
          whatsappWebState: "PREFLIGHT_REQUIRED",
          preflightCompleted: false,
          preflightFingerprint: null,
          realSendAuthorized: false,
          retryAuthorized: true,
          retryAuthorizedAt: now.toISOString(),
          retryAuthorizedBy: input.actorId,
        } as Prisma.InputJsonValue,
      },
    });
    return { status: "SCHEDULED" as const, retryAuthorized: true };
  });
}
