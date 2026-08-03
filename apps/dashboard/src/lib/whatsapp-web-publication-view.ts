import type { WhatsAppWebQueueItem } from "@affiliate/database";

export type WhatsAppWebPublicationView = {
  state: string;
  storedState: string;
  badge: string;
  active: boolean;
  queuePosition: number | null;
  blockingPublicationId: string | null;
  plannedAt: string | null;
  plannedBy: string | null;
  planningRunId: string | null;
  visualInspectionRequired: boolean;
  visualInspectionConfirmed: boolean;
  visualInspectionAt: string | null;
  preflightRequired: boolean;
  preflightCompleted: boolean;
  preflightAt: string | null;
  authorizationStatus: string | null;
  authorizationExpiresAt: string | null;
  authorizationFingerprint: string | null;
  realSendAuthorized: boolean;
  realSendEligible: boolean;
  dispatchBlockedReason: string | null;
  deliveryConfirmedAt: string | null;
  deliveryUncertain: boolean;
  manualDeliveryResolution: string | null;
  manualDeliveryResolvedAt: string | null;
  retryAuthorized: boolean;
  stage: string | null;
  rootCause: string | null;
  transitionHistory: Array<{
    from: string;
    to: string;
    at: string;
    by: string;
    reason: string | null;
  }>;
  commands: string[];
};

function metadataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function optionalText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

const badges: Record<string, string> = {
  AWAITING_VISUAL_INSPECTION: "AGUARDANDO INSPEÇÃO VISUAL",
  VISUAL_INSPECTION_CONFIRMED: "INSPEÇÃO CONFIRMADA",
  PREFLIGHT_REQUIRED: "PREFLIGHT NECESSÁRIO",
  PREFLIGHT_READY: "PRONTO PARA AUTORIZAÇÃO",
  AUTHORIZED_FOR_SEND: "AUTORIZADO PARA ENVIO",
  AUTHORIZATION_EXPIRED: "AUTORIZAÇÃO EXPIRADA",
  BLOCKED_BY_ACTIVE_PUBLICATION: "AGUARDANDO PUBLICATION ANTERIOR",
  DELIVERY_UNCERTAIN: "ENTREGA INCERTA — FILA BLOQUEADA",
  CANCELLED: "CANCELADA",
  ARCHIVED: "ARQUIVADA",
  PUBLISHED: "PUBLICADA",
  SEND_IN_PROGRESS: "ENVIO EM ANDAMENTO",
};

export function whatsappWebPublicationView(
  input: { id: string; status: string; metadata: unknown },
  queueItem?: WhatsAppWebQueueItem,
): WhatsAppWebPublicationView | null {
  const metadata = metadataRecord(input.metadata);
  if (metadata.publicationMode !== "WEB_EXPERIMENTAL") return null;

  const storedState =
    queueItem?.state ??
    optionalText(metadata.whatsappWebState) ??
    (input.status === "SCHEDULED" ? "AWAITING_VISUAL_INSPECTION" : input.status);
  const state = queueItem?.effectiveState ?? storedState;
  const active = queueItem?.active ?? true;
  const authorizationStatus = optionalText(metadata.sendAuthorizationStatus);
  const transitionHistory = Array.isArray(metadata.whatsappWebTransitionHistory)
    ? metadata.whatsappWebTransitionHistory.flatMap((item) => {
        const entry = metadataRecord(item);
        const from = optionalText(entry.from);
        const to = optionalText(entry.to);
        const at = optionalText(entry.at);
        const by = optionalText(entry.by);
        return from && to && at && by
          ? [{ from, to, at, by, reason: optionalText(entry.reason) }]
          : [];
      })
    : [];
  const authorizationValid =
    active &&
    storedState === "AUTHORIZED_FOR_SEND" &&
    authorizationStatus === "ACTIVE";
  const commands = active
    ? [
        `npm run whatsapp:web:inspect-draft -- --publication-id ${input.id} --hold-ms 30000`,
        `npm run whatsapp:web:preflight -- --publication-id ${input.id}`,
        `npm run whatsapp:web:authorize-send -- --publication-id ${input.id} --expires-in-minutes 15`,
        `npm run whatsapp:web:config-check -- --publication-id ${input.id}`,
        ...(authorizationValid
          ? [
              `npm run whatsapp:web:publish -- --publication-id ${input.id} --confirm-send`,
            ]
          : []),
      ]
    : [];

  return {
    state,
    storedState,
    badge: badges[state] ?? state,
    active,
    queuePosition: queueItem?.position ?? null,
    blockingPublicationId: queueItem?.blockingPublicationId ?? null,
    plannedAt: queueItem?.plannedAt ?? optionalText(metadata.plannedAt),
    plannedBy: optionalText(metadata.plannedBy),
    planningRunId: optionalText(metadata.planningRunId),
    visualInspectionRequired: metadata.visualInspectionRequired !== false,
    visualInspectionConfirmed:
      metadata.visualInspectionConfirmed === true ||
      metadata.visualDraftInspectionConfirmed === true,
    visualInspectionAt:
      optionalText(metadata.visualInspectionAt) ??
      optionalText(metadata.lastVisualDraftInspectionAt),
    preflightRequired: metadata.preflightRequired !== false,
    preflightCompleted: metadata.preflightCompleted === true,
    preflightAt:
      optionalText(metadata.preflightAt) ?? optionalText(metadata.lastPreflightAt),
    authorizationStatus,
    authorizationExpiresAt: optionalText(metadata.sendAuthorizationExpiresAt),
    authorizationFingerprint: optionalText(metadata.sendAuthorizationFingerprint),
    realSendAuthorized: authorizationValid,
    realSendEligible: metadata.realSendEligible === true,
    dispatchBlockedReason:
      queueItem?.blockingPublicationId
        ? `ACTIVE_PUBLICATION:${queueItem.blockingPublicationId}`
        : optionalText(metadata.dispatchBlockedReason) ??
          (state === "AWAITING_VISUAL_INSPECTION"
            ? "VISUAL_DRAFT_INSPECTION_REQUIRED"
            : null),
    deliveryConfirmedAt: optionalText(metadata.deliveryConfirmedAt),
    deliveryUncertain: metadata.deliveryUncertain === true,
    manualDeliveryResolution: optionalText(metadata.manualDeliveryResolution),
    manualDeliveryResolvedAt: optionalText(metadata.manualDeliveryResolvedAt),
    retryAuthorized: metadata.retryAuthorized === true,
    stage: optionalText(metadata.stage),
    rootCause: optionalText(metadata.rootCause),
    transitionHistory,
    commands,
  };
}
