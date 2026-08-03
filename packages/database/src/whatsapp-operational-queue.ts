import { createHash, randomUUID } from "node:crypto";
import {
  Prisma,
  type Channel,
  type PrismaClient,
  type Publication,
} from "@prisma/client";

export const WHATSAPP_WEB_STATES = [
  "AWAITING_VISUAL_INSPECTION",
  "VISUAL_INSPECTION_CONFIRMED",
  "PREFLIGHT_REQUIRED",
  "PREFLIGHT_READY",
  "AUTHORIZED_FOR_SEND",
  "AUTHORIZATION_EXPIRED",
  "BLOCKED_BY_ACTIVE_PUBLICATION",
  "SEND_IN_PROGRESS",
  "PUBLISHED",
  "DELIVERY_UNCERTAIN",
  "CANCELLED",
  "ARCHIVED",
] as const;

export type WhatsAppWebState = (typeof WHATSAPP_WEB_STATES)[number];

export type WhatsAppWebQueueItem = {
  publicationId: string;
  channelId: string;
  state: WhatsAppWebState;
  effectiveState: WhatsAppWebState;
  position: number | null;
  active: boolean;
  blockingPublicationId: string | null;
  plannedAt: string;
  offerVersion: number;
  authorizationStatus: string | null;
  authorizationExpiresAt: string | null;
  fingerprint: string;
};

export type WhatsAppWebQueueStatus = {
  channelId: string;
  activePublicationId: string | null;
  activeState: WhatsAppWebState | null;
  waitingCount: number;
  deliveryUncertainCount: number;
  queueBlocked: boolean;
  total: number;
  authorizationsActive: number;
  authorizationsExpired: number;
  cancelledCount: number;
  archivedCount: number;
  items: WhatsAppWebQueueItem[];
};

type QueueDatabaseClient = PrismaClient | Prisma.TransactionClient;

type PublicationWithChannel = Publication & { channel: Channel };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function dateValue(value: unknown) {
  const raw = text(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function whatsappWebPublicationFingerprint(input: {
  publication: Pick<
    Publication,
    | "id"
    | "offerId"
    | "messagePayload"
    | "imageUrlSnapshot"
    | "affiliateUrlSnapshot"
    | "trackingUrlSnapshot"
    | "offerVersionSnapshot"
    | "currentPriceSnapshot"
  >;
  channel: Pick<Channel, "id" | "enabled" | "configuration">;
}) {
  const configuration = record(input.channel.configuration);
  const payload = JSON.parse(
    JSON.stringify({
      publication: {
        id: input.publication.id,
        offerId: input.publication.offerId,
        messagePayload: input.publication.messagePayload,
        imageUrlSnapshot: input.publication.imageUrlSnapshot,
        affiliateUrlSnapshot: input.publication.affiliateUrlSnapshot,
        trackingUrlSnapshot: input.publication.trackingUrlSnapshot,
        offerVersionSnapshot: input.publication.offerVersionSnapshot,
        currentPriceSnapshot: input.publication.currentPriceSnapshot,
      },
      channel: {
        id: input.channel.id,
        enabled: input.channel.enabled,
        publicationMode: configuration.publicationMode,
        groupDisplayName: configuration.groupDisplayName,
        webProfileKey: configuration.webProfileKey,
        webAutomationEnabled: configuration.webAutomationEnabled,
        webAutomationPaused: configuration.webAutomationPaused,
        webAutomationOwnershipConfirmed:
          configuration.webAutomationOwnershipConfirmed,
        webAutomationConfirmedAt: configuration.webAutomationConfirmedAt,
        sendImage: configuration.sendImage,
      },
    }),
  ) as unknown;
  return createHash("sha256").update(stableJson(payload)).digest("hex");
}

export function abbreviatedWhatsAppFingerprint(value: string | null) {
  return value ? value.slice(0, 12) : null;
}

export function isWhatsAppWebPublication(publication: Pick<Publication, "metadata">) {
  return record(publication.metadata).publicationMode === "WEB_EXPERIMENTAL";
}

export function isUnresolvedWhatsAppDelivery(
  publication: Pick<Publication, "metadata">,
) {
  const metadata = record(publication.metadata);
  return (
    metadata.deliveryUncertain === true &&
    typeof metadata.deliveryConfirmedAt !== "string" &&
    metadata.manualDeliveryResolution !== "MANUALLY_CONFIRMED_DELIVERED" &&
    metadata.manualDeliveryResolution !== "MANUALLY_CONFIRMED_NOT_DELIVERED"
  );
}

export function whatsappWebStoredState(
  publication: Pick<Publication, "status" | "metadata">,
  now = new Date(),
): WhatsAppWebState {
  const metadata = record(publication.metadata);
  if (text(metadata.archivedAt) || metadata.whatsappWebState === "ARCHIVED") {
    return "ARCHIVED";
  }
  if (publication.status === "PUBLISHED") return "PUBLISHED";
  if (
    metadata.manualDeliveryResolution ===
      "MANUALLY_CONFIRMED_NOT_DELIVERED" &&
    metadata.retryAuthorized !== true
  ) {
    return "CANCELLED";
  }
  if (
    publication.status === "CANCELLED" ||
    metadata.whatsappWebState === "CANCELLED"
  ) {
    return "CANCELLED";
  }
  if (isUnresolvedWhatsAppDelivery(publication)) return "DELIVERY_UNCERTAIN";
  if (metadata.sendAuthorizationStatus === "CLAIMED") return "SEND_IN_PROGRESS";
  if (metadata.sendAuthorizationStatus === "ACTIVE") {
    const expiresAt = dateValue(metadata.sendAuthorizationExpiresAt);
    return expiresAt && expiresAt.getTime() > now.getTime()
      ? "AUTHORIZED_FOR_SEND"
      : "AUTHORIZATION_EXPIRED";
  }
  const state = text(metadata.whatsappWebState);
  return WHATSAPP_WEB_STATES.includes(state as WhatsAppWebState)
    ? (state as WhatsAppWebState)
    : "AWAITING_VISUAL_INSPECTION";
}

export function isWhatsAppWebTerminalState(state: WhatsAppWebState) {
  return state === "PUBLISHED" || state === "CANCELLED" || state === "ARCHIVED";
}

function plannedAt(publication: Publication) {
  return dateValue(record(publication.metadata).plannedAt) ?? publication.scheduledAt;
}

function queueOrder(left: Publication, right: Publication) {
  const plannedDifference = plannedAt(left).getTime() - plannedAt(right).getTime();
  if (plannedDifference !== 0) return plannedDifference;
  const createdDifference = left.createdAt.getTime() - right.createdAt.getTime();
  return createdDifference !== 0 ? createdDifference : left.id.localeCompare(right.id);
}

export function buildWhatsAppWebQueueStatus(
  channel: Channel,
  publications: Publication[],
  now = new Date(),
): WhatsAppWebQueueStatus {
  const webPublications = publications
    .filter(isWhatsAppWebPublication)
    .sort(queueOrder);
  const unresolved = webPublications.filter(isUnresolvedWhatsAppDelivery);
  const nonTerminal = webPublications.filter(
    (publication) => !isWhatsAppWebTerminalState(whatsappWebStoredState(publication, now)),
  );
  const activePublication = unresolved[0] ?? nonTerminal[0] ?? null;
  const waiting = nonTerminal.filter(
    (publication) => publication.id !== activePublication?.id,
  );

  return {
    channelId: channel.id,
    activePublicationId: activePublication?.id ?? null,
    activeState: activePublication
      ? whatsappWebStoredState(activePublication, now)
      : null,
    waitingCount: waiting.length,
    deliveryUncertainCount: unresolved.length,
    queueBlocked: Boolean(activePublication),
    total: nonTerminal.length,
    authorizationsActive: nonTerminal.filter(
      (publication) =>
        record(publication.metadata).sendAuthorizationStatus === "ACTIVE" &&
        whatsappWebStoredState(publication, now) === "AUTHORIZED_FOR_SEND",
    ).length,
    authorizationsExpired: nonTerminal.filter(
      (publication) => whatsappWebStoredState(publication, now) === "AUTHORIZATION_EXPIRED",
    ).length,
    cancelledCount: webPublications.filter(
      (publication) => whatsappWebStoredState(publication, now) === "CANCELLED",
    ).length,
    archivedCount: webPublications.filter(
      (publication) => whatsappWebStoredState(publication, now) === "ARCHIVED",
    ).length,
    items: webPublications.map((publication) => {
      const state = whatsappWebStoredState(publication, now);
      const active = publication.id === activePublication?.id;
      const waitingPosition = waiting.findIndex(
        (candidate) => candidate.id === publication.id,
      );
      const metadata = record(publication.metadata);
      return {
        publicationId: publication.id,
        channelId: publication.channelId,
        state,
        effectiveState:
          !active && !isWhatsAppWebTerminalState(state)
            ? "BLOCKED_BY_ACTIVE_PUBLICATION"
            : state,
        position: active ? 1 : waitingPosition >= 0 ? waitingPosition + 2 : null,
        active,
        blockingPublicationId:
          !active && !isWhatsAppWebTerminalState(state)
            ? (activePublication?.id ?? null)
            : null,
        plannedAt: plannedAt(publication).toISOString(),
        offerVersion: publication.offerVersionSnapshot,
        authorizationStatus: text(metadata.sendAuthorizationStatus),
        authorizationExpiresAt: text(metadata.sendAuthorizationExpiresAt),
        fingerprint: whatsappWebPublicationFingerprint({ publication, channel }),
      };
    }),
  };
}

async function queueRecords(client: QueueDatabaseClient, channelId: string) {
  const [channel, publications] = await Promise.all([
    client.channel.findUnique({ where: { id: channelId } }),
    client.publication.findMany({
      where: { channelId },
      orderBy: [{ scheduledAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    }),
  ]);
  if (!channel || channel.type !== "WHATSAPP_GROUPS") {
    throw new Error("WHATSAPP_WEB_CHANNEL_NOT_FOUND");
  }
  return { channel, publications };
}

export async function getWhatsAppWebQueueStatus(
  client: QueueDatabaseClient,
  channelId: string,
  now = new Date(),
) {
  const { channel, publications } = await queueRecords(client, channelId);
  return buildWhatsAppWebQueueStatus(channel, publications, now);
}

export async function lockWhatsAppWebChannelForUpdate(
  transaction: Prisma.TransactionClient,
  channelId: string,
) {
  const rows = await transaction.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT "id" FROM "Channel" WHERE "id" = ${channelId} FOR UPDATE`,
  );
  if (rows.length !== 1) throw new Error("WHATSAPP_WEB_CHANNEL_NOT_FOUND");
}

async function transactionalQueue(
  transaction: Prisma.TransactionClient,
  channelId: string,
  now: Date,
) {
  await lockWhatsAppWebChannelForUpdate(transaction, channelId);
  return getWhatsAppWebQueueStatus(transaction, channelId, now);
}

export async function assertWhatsAppWebActivePublication(
  client: QueueDatabaseClient,
  publicationId: string,
  now = new Date(),
) {
  const publication = await client.publication.findUnique({
    where: { id: publicationId },
    include: { channel: true },
  });
  if (!publication || !isWhatsAppWebPublication(publication)) {
    throw new Error("PUBLICATION_NOT_FOUND");
  }
  const queue = await getWhatsAppWebQueueStatus(client, publication.channelId, now);
  if (queue.deliveryUncertainCount > 0 && queue.activePublicationId !== publicationId) {
    throw new Error("WHATSAPP_WEB_CHANNEL_BLOCKED_BY_DELIVERY_UNCERTAIN");
  }
  if (queue.activePublicationId !== publicationId) {
    throw new Error("WHATSAPP_WEB_ACTIVE_PUBLICATION_MISMATCH");
  }
  return { publication: publication as PublicationWithChannel, queue };
}

export async function assertWhatsAppWebPreflightEligible(
  client: QueueDatabaseClient,
  publicationId: string,
  now = new Date(),
) {
  const active = await assertWhatsAppWebActivePublication(
    client,
    publicationId,
    now,
  );
  const metadata = record(active.publication.metadata);
  const fingerprint = whatsappWebPublicationFingerprint({
    publication: active.publication,
    channel: active.publication.channel,
  });
  if (
    metadata.visualInspectionConfirmed !== true ||
    metadata.visualInspectionFingerprint !== fingerprint
  ) {
    throw new Error("WHATSAPP_WEB_VISUAL_DRAFT_INSPECTION_REQUIRED");
  }
  return { ...active, fingerprint };
}

function invalidatedOperationalMetadata(
  previous: Record<string, unknown>,
  state: WhatsAppWebState,
) {
  return {
    ...previous,
    whatsappWebState: state,
    preflightCompleted: false,
    preflightFingerprint: null,
    preflightAt: null,
    realSendAuthorized: false,
    sendAuthorizationStatus: previous.sendAuthorizationStatus
      ? "INVALIDATED"
      : null,
    sendAuthorizationRevokedAt: previous.sendAuthorizationStatus
      ? new Date().toISOString()
      : null,
  };
}

function transitionHistory(
  previous: Record<string, unknown>,
  entry: {
    from: WhatsAppWebState;
    to: WhatsAppWebState;
    at: string;
    by: string;
    reason?: string;
  },
) {
  const history = Array.isArray(previous.whatsappWebTransitionHistory)
    ? previous.whatsappWebTransitionHistory.filter(
        (item) => item && typeof item === "object" && !Array.isArray(item),
      )
    : [];
  return [...history, entry].slice(-50);
}

export async function recordWhatsAppWebVisualInspection(
  client: PrismaClient,
  input: {
    publicationId: string;
    confirmed: boolean;
    actorId: string;
    result: Record<string, unknown>;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  return client.$transaction(async (transaction) => {
    const publication = await transaction.publication.findUnique({
      where: { id: input.publicationId },
      include: { channel: true },
    });
    if (!publication) throw new Error("PUBLICATION_NOT_FOUND");
    const queue = await transactionalQueue(transaction, publication.channelId, now);
    if (queue.activePublicationId !== publication.id) {
      throw new Error("WHATSAPP_WEB_ACTIVE_PUBLICATION_MISMATCH");
    }
    const previous = record(publication.metadata);
    const previousState = whatsappWebStoredState(publication, now);
    const fingerprint = whatsappWebPublicationFingerprint({
      publication,
      channel: publication.channel,
    });
    const metadata = input.confirmed
      ? {
          ...invalidatedOperationalMetadata(previous, "VISUAL_INSPECTION_CONFIRMED"),
          visualInspectionConfirmed: true,
          visualDraftInspectionConfirmed: true,
          visualInspectionFingerprint: fingerprint,
          lastVisualDraftInspectionFingerprint: text(
            input.result.visualDraftInspectionFingerprint,
          ),
          visualInspectionAt: now.toISOString(),
          visualInspectionBy: input.actorId,
          lastVisualDraftInspection: input.result,
          dispatchBlockedReason: "PREFLIGHT_REQUIRED",
          whatsappWebTransitionHistory: transitionHistory(previous, {
            from: previousState,
            to: "VISUAL_INSPECTION_CONFIRMED",
            at: now.toISOString(),
            by: input.actorId,
          }),
        }
      : {
          ...invalidatedOperationalMetadata(previous, "AWAITING_VISUAL_INSPECTION"),
          visualInspectionConfirmed: false,
          visualDraftInspectionConfirmed: false,
          visualInspectionRejectedAt: now.toISOString(),
          visualInspectionRejectedBy: input.actorId,
          lastVisualDraftInspection: input.result,
          dispatchBlockedReason: "VISUAL_DRAFT_INSPECTION_REQUIRED",
          whatsappWebTransitionHistory: transitionHistory(previous, {
            from: previousState,
            to: "AWAITING_VISUAL_INSPECTION",
            at: now.toISOString(),
            by: input.actorId,
            reason: "VISUAL_DRAFT_REJECTED",
          }),
        };
    await transaction.publication.update({
      where: { id: publication.id },
      data: { metadata: metadata as Prisma.InputJsonValue },
    });
    return {
      publicationId: publication.id,
      previousState,
      state: metadata.whatsappWebState,
      fingerprint,
      sendCalled: false,
    };
  });
}

export async function recordWhatsAppWebPreflight(
  client: PrismaClient,
  input: {
    publicationId: string;
    ready: boolean;
    actorId: string;
    result: Record<string, unknown>;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  return client.$transaction(async (transaction) => {
    const publication = await transaction.publication.findUnique({
      where: { id: input.publicationId },
      include: { channel: true },
    });
    if (!publication) throw new Error("PUBLICATION_NOT_FOUND");
    const queue = await transactionalQueue(transaction, publication.channelId, now);
    if (queue.activePublicationId !== publication.id) {
      throw new Error("WHATSAPP_WEB_ACTIVE_PUBLICATION_MISMATCH");
    }
    const previous = record(publication.metadata);
    const previousState = whatsappWebStoredState(publication, now);
    const fingerprint = whatsappWebPublicationFingerprint({
      publication,
      channel: publication.channel,
    });
    if (
      previous.visualInspectionConfirmed !== true ||
      previous.visualInspectionFingerprint !== fingerprint
    ) {
      throw new Error("WHATSAPP_WEB_VISUAL_DRAFT_INSPECTION_REQUIRED");
    }
    const metadata = input.ready
      ? {
          ...invalidatedOperationalMetadata(previous, "PREFLIGHT_READY"),
          visualInspectionConfirmed: true,
          preflightCompleted: true,
          preflightFingerprint: fingerprint,
          preflightAt: now.toISOString(),
          preflightBy: input.actorId,
          lastPreflight: input.result,
          dispatchBlockedReason: "SEND_AUTHORIZATION_REQUIRED",
          whatsappWebTransitionHistory: transitionHistory(previous, {
            from: previousState,
            to: "PREFLIGHT_READY",
            at: now.toISOString(),
            by: input.actorId,
          }),
        }
      : {
          ...invalidatedOperationalMetadata(previous, "PREFLIGHT_REQUIRED"),
          visualInspectionConfirmed: true,
          lastPreflight: input.result,
          lastPreflightFailedAt: now.toISOString(),
          lastPreflightFailedBy: input.actorId,
          stage: text(input.result.stage),
          rootCause: text(input.result.errorCode) ?? text(input.result.stage),
          dispatchBlockedReason: "PREFLIGHT_REQUIRED",
          whatsappWebTransitionHistory: transitionHistory(previous, {
            from: previousState,
            to: "PREFLIGHT_REQUIRED",
            at: now.toISOString(),
            by: input.actorId,
            reason: text(input.result.errorCode) ?? "PREFLIGHT_FAILED",
          }),
        };
    await transaction.publication.update({
      where: { id: publication.id },
      data: { metadata: metadata as Prisma.InputJsonValue },
    });
    return {
      publicationId: publication.id,
      previousState,
      state: metadata.whatsappWebState,
      fingerprint,
      sendCalled: false,
    };
  });
}

function channelAuthorizationError(channel: Channel) {
  const configuration = record(channel.configuration);
  if (!channel.enabled) return "WHATSAPP_WEB_CHANNEL_DISABLED";
  if (configuration.webAutomationPaused === true) return "WHATSAPP_WEB_CHANNEL_PAUSED";
  if (configuration.publicationMode !== "WEB_EXPERIMENTAL") {
    return "WHATSAPP_WEB_PUBLICATION_MODE_INVALID";
  }
  if (configuration.webAutomationEnabled !== true) {
    return "WHATSAPP_WEB_AUTOMATION_DISABLED";
  }
  if (
    configuration.webAutomationOwnershipConfirmed !== true ||
    !text(configuration.webAutomationConfirmedAt)
  ) {
    return "WHATSAPP_WEB_OWNERSHIP_NOT_CONFIRMED";
  }
  return null;
}

function validateAuthorizationMetadata(
  publication: PublicationWithChannel,
  queue: WhatsAppWebQueueStatus,
  now: Date,
) {
  if (queue.deliveryUncertainCount > 0) {
    throw new Error("WHATSAPP_WEB_CHANNEL_BLOCKED_BY_DELIVERY_UNCERTAIN");
  }
  if (queue.activePublicationId !== publication.id) {
    throw new Error("WHATSAPP_WEB_ACTIVE_PUBLICATION_MISMATCH");
  }
  const channelError = channelAuthorizationError(publication.channel);
  if (channelError) throw new Error(channelError);
  const metadata = record(publication.metadata);
  if (publication.status === "PUBLISHED") {
    throw new Error("WHATSAPP_WEB_PUBLICATION_ALREADY_PUBLISHED");
  }
  if (publication.status === "CANCELLED" || text(metadata.archivedAt)) {
    throw new Error("WHATSAPP_WEB_PUBLICATION_INELIGIBLE");
  }
  if (text(metadata.sendClickStartedAt)) {
    throw new Error("WHATSAPP_WEB_SEND_ALREADY_STARTED");
  }
  const fingerprint = whatsappWebPublicationFingerprint({
    publication,
    channel: publication.channel,
  });
  if (
    metadata.visualInspectionConfirmed !== true ||
    metadata.visualInspectionFingerprint !== fingerprint
  ) {
    throw new Error("WHATSAPP_WEB_VISUAL_DRAFT_INSPECTION_REQUIRED");
  }
  if (
    metadata.preflightCompleted !== true ||
    metadata.preflightFingerprint !== fingerprint
  ) {
    throw new Error("WHATSAPP_WEB_PREFLIGHT_REQUIRED");
  }
  const state = whatsappWebStoredState(publication, now);
  if (state !== "PREFLIGHT_READY" && state !== "AUTHORIZATION_EXPIRED") {
    throw new Error("WHATSAPP_WEB_INVALID_STATE_TRANSITION");
  }
  return { metadata, fingerprint };
}

export async function authorizeWhatsAppWebSend(
  client: PrismaClient,
  input: {
    publicationId: string;
    actorId: string;
    expiresInMinutes: number;
    now?: Date;
  },
) {
  if (!Number.isInteger(input.expiresInMinutes) || input.expiresInMinutes < 1 || input.expiresInMinutes > 60) {
    throw new Error("WHATSAPP_WEB_SEND_AUTHORIZATION_EXPIRY_INVALID");
  }
  const now = input.now ?? new Date();
  return client.$transaction(async (transaction) => {
    const publication = await transaction.publication.findUnique({
      where: { id: input.publicationId },
      include: { channel: true },
    });
    if (!publication) throw new Error("PUBLICATION_NOT_FOUND");
    const queue = await transactionalQueue(transaction, publication.channelId, now);
    const existingMetadata = record(publication.metadata);
    const existingExpiresAt = dateValue(existingMetadata.sendAuthorizationExpiresAt);
    const fingerprint = whatsappWebPublicationFingerprint({
      publication,
      channel: publication.channel,
    });
    if (
      existingMetadata.sendAuthorizationStatus === "ACTIVE" &&
      existingMetadata.sendAuthorizationFingerprint === fingerprint &&
      existingExpiresAt &&
      existingExpiresAt.getTime() > now.getTime()
    ) {
      return {
        status: "AUTHORIZED_FOR_SEND" as const,
        publicationId: publication.id,
        authorizationId: text(existingMetadata.sendAuthorizationId),
        authorizationValid: true,
        authorizationCreatedAt: text(existingMetadata.sendAuthorizationCreatedAt),
        authorizationExpiresAt: existingExpiresAt.toISOString(),
        fingerprint,
        idempotent: true,
        browserOpened: false,
        sendCalled: false,
      };
    }
    const validated = validateAuthorizationMetadata(publication, queue, now);
    const authorizationId = randomUUID();
    const expiresAt = new Date(now.getTime() + input.expiresInMinutes * 60_000);
    const metadata = {
      ...validated.metadata,
      whatsappWebState: "AUTHORIZED_FOR_SEND",
      realSendAuthorized: true,
      sendAuthorizationId: authorizationId,
      sendAuthorizationFingerprint: validated.fingerprint,
      sendAuthorizationCreatedAt: now.toISOString(),
      sendAuthorizationExpiresAt: expiresAt.toISOString(),
      sendAuthorizationCreatedBy: input.actorId,
      sendAuthorizationStatus: "ACTIVE",
      sendAuthorizationConsumedAt: null,
      sendAuthorizationRevokedAt: null,
      sendAuthorizationRevokedBy: null,
      sendAuthorizationRevocationReason: null,
      dispatchBlockedReason: null,
      whatsappWebTransitionHistory: transitionHistory(validated.metadata, {
        from: whatsappWebStoredState(publication, now),
        to: "AUTHORIZED_FOR_SEND",
        at: now.toISOString(),
        by: input.actorId,
      }),
    };
    await transaction.publication.update({
      where: { id: publication.id },
      data: { metadata: metadata as Prisma.InputJsonValue },
    });
    return {
      status: "AUTHORIZED_FOR_SEND" as const,
      publicationId: publication.id,
      authorizationId,
      authorizationValid: true,
      authorizationCreatedAt: now.toISOString(),
      authorizationExpiresAt: expiresAt.toISOString(),
      fingerprint: validated.fingerprint,
      idempotent: false,
      browserOpened: false,
      sendCalled: false,
    };
  });
}

export async function revokeWhatsAppWebSendAuthorization(
  client: PrismaClient,
  input: { publicationId: string; actorId: string; reason: string; now?: Date },
) {
  const now = input.now ?? new Date();
  return client.$transaction(async (transaction) => {
    const publication = await transaction.publication.findUnique({
      where: { id: input.publicationId },
      include: { channel: true },
    });
    if (!publication) throw new Error("PUBLICATION_NOT_FOUND");
    await lockWhatsAppWebChannelForUpdate(transaction, publication.channelId);
    const metadata = record(publication.metadata);
    if (text(metadata.sendClickStartedAt)) {
      throw new Error("WHATSAPP_WEB_SEND_ALREADY_STARTED");
    }
    if (metadata.sendAuthorizationStatus === "REVOKED") {
      return { publicationId: publication.id, state: whatsappWebStoredState(publication, now), idempotent: true, browserOpened: false, sendCalled: false };
    }
    const fingerprint = whatsappWebPublicationFingerprint({ publication, channel: publication.channel });
    const preflightValid =
      metadata.preflightCompleted === true && metadata.preflightFingerprint === fingerprint;
    const state = preflightValid ? "PREFLIGHT_READY" : "PREFLIGHT_REQUIRED";
    await transaction.publication.update({
      where: { id: publication.id },
      data: {
        metadata: {
          ...metadata,
          whatsappWebState: state,
          realSendAuthorized: false,
          sendAuthorizationStatus: "REVOKED",
          sendAuthorizationRevokedAt: now.toISOString(),
          sendAuthorizationRevokedBy: input.actorId,
          sendAuthorizationRevocationReason: input.reason,
          dispatchBlockedReason: preflightValid
            ? "SEND_AUTHORIZATION_REQUIRED"
            : "PREFLIGHT_REQUIRED",
          whatsappWebTransitionHistory: transitionHistory(metadata, {
            from: whatsappWebStoredState(publication, now),
            to: state,
            at: now.toISOString(),
            by: input.actorId,
            reason: input.reason,
          }),
        } as Prisma.InputJsonValue,
      },
    });
    return { publicationId: publication.id, state, idempotent: false, browserOpened: false, sendCalled: false };
  });
}

export async function cancelWhatsAppWebPublication(
  client: PrismaClient,
  input: { publicationId: string; actorId: string; reason: string; now?: Date },
) {
  const now = input.now ?? new Date();
  return client.$transaction(async (transaction) => {
    const publication = await transaction.publication.findUnique({
      where: { id: input.publicationId },
      include: { channel: true },
    });
    if (!publication || !isWhatsAppWebPublication(publication)) {
      throw new Error("PUBLICATION_NOT_FOUND");
    }
    await lockWhatsAppWebChannelForUpdate(transaction, publication.channelId);
    const queueBefore = await getWhatsAppWebQueueStatus(
      transaction,
      publication.channelId,
      now,
    );
    const metadata = record(publication.metadata);
    const previousState = whatsappWebStoredState(publication, now);
    if (previousState === "CANCELLED") {
      return { publicationId: publication.id, state: "CANCELLED" as const, promotedPublicationId: null, idempotent: true, browserOpened: false, sendCalled: false };
    }
    if (
      publication.status === "PUBLISHED" ||
      previousState === "ARCHIVED" ||
      isUnresolvedWhatsAppDelivery(publication) ||
      metadata.sendWasClicked === true ||
      text(metadata.sendClickStartedAt)
    ) {
      throw new Error("WHATSAPP_WEB_PUBLICATION_CANNOT_BE_CANCELLED");
    }
    const promotedCandidateId =
      queueBefore.activePublicationId === publication.id
        ? (queueBefore.items.find((item) => item.position === 2)?.publicationId ??
          null)
        : null;
    await transaction.publication.update({
      where: { id: publication.id },
      data: {
        status: "CANCELLED",
        metadata: {
          ...metadata,
          previousWhatsappWebState: previousState,
          whatsappWebState: "CANCELLED",
          cancelledAt: now.toISOString(),
          cancelledBy: input.actorId,
          cancellationReason: input.reason,
          promotedPublicationId: promotedCandidateId,
          realSendAuthorized: false,
          sendAuthorizationStatus: metadata.sendAuthorizationStatus ? "REVOKED" : null,
          sendAuthorizationRevokedAt: metadata.sendAuthorizationStatus ? now.toISOString() : null,
          sendAuthorizationRevokedBy: metadata.sendAuthorizationStatus ? input.actorId : null,
          sendAuthorizationRevocationReason: metadata.sendAuthorizationStatus ? "PUBLICATION_CANCELLED" : null,
          whatsappWebTransitionHistory: transitionHistory(metadata, {
            from: previousState,
            to: "CANCELLED",
            at: now.toISOString(),
            by: input.actorId,
            reason: input.reason,
          }),
        } as Prisma.InputJsonValue,
      },
    });
    const queue = await getWhatsAppWebQueueStatus(transaction, publication.channelId, now);
    return { publicationId: publication.id, state: "CANCELLED" as const, promotedPublicationId: queue.activePublicationId, idempotent: false, browserOpened: false, sendCalled: false };
  });
}

export async function archiveWhatsAppWebPublication(
  client: PrismaClient,
  input: { publicationId: string; actorId: string; reason: string; now?: Date },
) {
  const now = input.now ?? new Date();
  return client.$transaction(async (transaction) => {
    const publication = await transaction.publication.findUnique({
      where: { id: input.publicationId },
      include: { channel: true },
    });
    if (!publication || !isWhatsAppWebPublication(publication)) {
      throw new Error("PUBLICATION_NOT_FOUND");
    }
    await lockWhatsAppWebChannelForUpdate(transaction, publication.channelId);
    const metadata = record(publication.metadata);
    const previousState = whatsappWebStoredState(publication, now);
    if (previousState === "ARCHIVED") {
      return { publicationId: publication.id, state: "ARCHIVED" as const, idempotent: true, browserOpened: false, sendCalled: false };
    }
    if (isUnresolvedWhatsAppDelivery(publication)) {
      throw new Error("WHATSAPP_WEB_DELIVERY_UNCERTAIN");
    }
    if (!isWhatsAppWebTerminalState(previousState)) {
      throw new Error("WHATSAPP_WEB_ARCHIVE_REQUIRES_TERMINAL_STATE");
    }
    await transaction.publication.update({
      where: { id: publication.id },
      data: {
        metadata: {
          ...metadata,
          previousWhatsappWebState: previousState,
          whatsappWebState: "ARCHIVED",
          archivedAt: now.toISOString(),
          archivedBy: input.actorId,
          archiveReason: input.reason,
          whatsappWebTransitionHistory: transitionHistory(metadata, {
            from: previousState,
            to: "ARCHIVED",
            at: now.toISOString(),
            by: input.actorId,
            reason: input.reason,
          }),
        } as Prisma.InputJsonValue,
      },
    });
    return { publicationId: publication.id, state: "ARCHIVED" as const, idempotent: false, browserOpened: false, sendCalled: false };
  });
}

export async function claimWhatsAppWebSendAuthorization(
  client: PrismaClient,
  input: { publicationId: string; actorId: string; now?: Date },
) {
  const now = input.now ?? new Date();
  return client.$transaction(async (transaction) => {
    const publication = await transaction.publication.findUnique({
      where: { id: input.publicationId },
      include: { channel: true },
    });
    if (!publication) throw new Error("PUBLICATION_NOT_FOUND");
    const queue = await transactionalQueue(transaction, publication.channelId, now);
    if (queue.activePublicationId !== publication.id) {
      throw new Error("WHATSAPP_WEB_ACTIVE_PUBLICATION_MISMATCH");
    }
    if (queue.deliveryUncertainCount > 0) {
      throw new Error("WHATSAPP_WEB_CHANNEL_BLOCKED_BY_DELIVERY_UNCERTAIN");
    }
    const metadata = record(publication.metadata);
    if (metadata.sendAuthorizationStatus === "CLAIMED") {
      throw new Error("WHATSAPP_WEB_SEND_AUTHORIZATION_ALREADY_CONSUMED");
    }
    if (metadata.sendAuthorizationStatus === "REVOKED") {
      throw new Error("WHATSAPP_WEB_SEND_AUTHORIZATION_REVOKED");
    }
    if (metadata.sendAuthorizationStatus !== "ACTIVE") {
      throw new Error("WHATSAPP_WEB_SEND_AUTHORIZATION_REQUIRED");
    }
    const expiresAt = dateValue(metadata.sendAuthorizationExpiresAt);
    if (!expiresAt || expiresAt.getTime() <= now.getTime()) {
      throw new Error("WHATSAPP_WEB_SEND_AUTHORIZATION_EXPIRED");
    }
    const fingerprint = whatsappWebPublicationFingerprint({ publication, channel: publication.channel });
    if (metadata.sendAuthorizationFingerprint !== fingerprint) {
      throw new Error("WHATSAPP_WEB_SEND_AUTHORIZATION_FINGERPRINT_MISMATCH");
    }
    await transaction.publication.update({
      where: { id: publication.id },
      data: {
        metadata: {
          ...metadata,
          whatsappWebState: "SEND_IN_PROGRESS",
          sendAuthorizationStatus: "CLAIMED",
          sendAuthorizationClaimedAt: now.toISOString(),
          sendAuthorizationClaimedBy: input.actorId,
          realSendAuthorized: false,
          whatsappWebTransitionHistory: transitionHistory(metadata, {
            from: "AUTHORIZED_FOR_SEND",
            to: "SEND_IN_PROGRESS",
            at: now.toISOString(),
            by: input.actorId,
          }),
        } as Prisma.InputJsonValue,
      },
    });
    return { publicationId: publication.id, authorizationId: text(metadata.sendAuthorizationId), claimedAt: now.toISOString(), fingerprint };
  });
}
