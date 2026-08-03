export type WhatsAppWebPublicationView = {
  state: string;
  badge: string;
  plannedAt: string | null;
  plannedBy: string | null;
  planningRunId: string | null;
  visualInspectionRequired: boolean;
  visualInspectionConfirmed: boolean;
  preflightRequired: boolean;
  preflightCompleted: boolean;
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

export function whatsappWebPublicationView(input: {
  id: string;
  status: string;
  metadata: unknown;
}): WhatsAppWebPublicationView | null {
  const metadata = metadataRecord(input.metadata);
  if (metadata.publicationMode !== "WEB_EXPERIMENTAL") return null;

  const state =
    optionalText(metadata.whatsappWebState) ??
    (input.status === "SCHEDULED"
      ? "AWAITING_VISUAL_INSPECTION"
      : input.status);

  return {
    state,
    badge:
      state === "AWAITING_VISUAL_INSPECTION"
        ? "AGUARDANDO INSPEÇÃO VISUAL"
        : state,
    plannedAt: optionalText(metadata.plannedAt),
    plannedBy: optionalText(metadata.plannedBy),
    planningRunId: optionalText(metadata.planningRunId),
    visualInspectionRequired: metadata.visualInspectionRequired !== false,
    visualInspectionConfirmed: metadata.visualInspectionConfirmed === true,
    preflightRequired: metadata.preflightRequired !== false,
    preflightCompleted: metadata.preflightCompleted === true,
    realSendAuthorized: metadata.realSendAuthorized === true,
    realSendEligible: metadata.realSendEligible === true,
    dispatchBlockedReason:
      optionalText(metadata.dispatchBlockedReason) ??
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
    commands: [
      `npm run whatsapp:web:inspect-draft -- --publication-id ${input.id} --hold-ms 20000`,
      `npm run whatsapp:web:preflight -- --publication-id ${input.id}`,
      `npm run whatsapp:web:config-check -- --publication-id ${input.id}`,
      `npm run whatsapp:web:publish -- --publication-id ${input.id} --confirm-send`,
    ],
  };
}
