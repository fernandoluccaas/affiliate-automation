import type { Prisma } from "@affiliate/database";

export const ASSISTED_GROUP_INTRO =
  "O texto exibido e o snapshot imutavel que sera copiado. Publique no grupo e confirme manualmente.";

export function assistedGroupConfirmationPrompt(groupDisplayName: string) {
  return `Confirma que esta oferta foi publicada no grupo '${groupDisplayName}'?`;
}

function metadataRecord(value: Prisma.JsonValue | null) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Prisma.JsonObject)
    : {};
}

export function assistedConfirmationData(
  metadata: Prisma.JsonValue | null,
  userId: string,
  now: Date,
  groupDisplayName: string,
) {
  return {
    status: "PUBLISHED" as const,
    publishedAt: now,
    externalId: null,
    errorMessage: null,
    metadata: {
      ...metadataRecord(metadata),
      publicationMode: "ASSISTED",
      whatsappDestinationType: "GROUP",
      groupDisplayNameSnapshot: groupDisplayName,
      manualConfirmation: true,
      confirmationStrategy: "MANUAL",
      confirmedBy: userId,
      confirmedByUserId: userId,
      confirmedAt: now.toISOString(),
    },
  };
}

export function groupDisplayNameFromSnapshot(
  metadata: Prisma.JsonValue | null,
  configuration: Prisma.JsonValue | null,
  fallback: string,
) {
  const snapshot = metadataRecord(metadata).groupDisplayNameSnapshot;
  if (typeof snapshot === "string" && snapshot.trim()) return snapshot.trim();
  const configured = metadataRecord(configuration).groupDisplayName;
  return typeof configured === "string" && configured.trim()
    ? configured.trim()
    : fallback;
}

export function convertLegacyWhatsAppConfiguration(
  configuration: Prisma.JsonValue | null,
  fallbackName: string,
) {
  const current = metadataRecord(configuration);
  const legacyDisplayName = current.channelDisplayName;
  const configuredGroupName = current.groupDisplayName;
  const legacyMaxPending = current.maxPending;
  const preserved = Object.fromEntries(
    Object.entries(current).filter(
      ([key]) => !["channelDisplayName", "maxPending"].includes(key),
    ),
  );

  return {
    ...preserved,
    publicationMode: "ASSISTED",
    whatsappDestinationType: "GROUP",
    groupDisplayName:
      typeof configuredGroupName === "string" && configuredGroupName.trim()
        ? configuredGroupName.trim()
        : typeof legacyDisplayName === "string" && legacyDisplayName.trim()
          ? legacyDisplayName.trim()
          : fallbackName,
    maxPendingPublications:
      typeof current.maxPendingPublications === "number"
        ? current.maxPendingPublications
        : typeof legacyMaxPending === "number"
          ? legacyMaxPending
          : 3,
  };
}

export function assistedCancellationData(
  metadata: Prisma.JsonValue | null,
  userId: string,
  now: Date,
) {
  return {
    status: "CANCELLED" as const,
    metadata: {
      ...metadataRecord(metadata),
      publicationMode: "ASSISTED",
      skippedByUserId: userId,
      skippedAt: now.toISOString(),
    },
  };
}

export function assistedFailureData(
  metadata: Prisma.JsonValue | null,
  userId: string,
  now: Date,
  reason?: string,
) {
  return {
    status: "PUBLICATION_FAILED" as const,
    errorMessage:
      reason?.trim().slice(0, 500) ||
      "Falha informada durante a publicacao assistida.",
    metadata: {
      ...metadataRecord(metadata),
      publicationMode: "ASSISTED",
      failedByUserId: userId,
      failedAt: now.toISOString(),
    },
  };
}
