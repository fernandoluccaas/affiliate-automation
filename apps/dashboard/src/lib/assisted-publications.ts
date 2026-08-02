import type { Prisma } from "@affiliate/database";

function metadataRecord(value: Prisma.JsonValue | null) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Prisma.JsonObject)
    : {};
}

export function assistedConfirmationData(
  metadata: Prisma.JsonValue | null,
  userId: string,
  now: Date,
) {
  return {
    status: "PUBLISHED" as const,
    publishedAt: now,
    externalId: null,
    errorMessage: null,
    metadata: {
      ...metadataRecord(metadata),
      publicationMode: "ASSISTED",
      confirmationStrategy: "MANUAL",
      confirmedByUserId: userId,
      confirmedAt: now.toISOString(),
    },
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
