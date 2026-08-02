import { describe, expect, it } from "vitest";
import {
  assistedCancellationData,
  assistedGroupConfirmationPrompt,
  assistedConfirmationData,
  assistedFailureData,
  convertLegacyWhatsAppConfiguration,
  groupDisplayNameFromSnapshot,
  ASSISTED_GROUP_INTRO,
} from "./assisted-publications";

describe("assisted publication transitions", () => {
  const now = new Date("2026-08-02T12:00:00.000Z");

  it("confirms manually without fabricating an external message id", () => {
    expect(assistedConfirmationData({ mediaFallbackUsed: false }, "user-1", now, "Grupo A")).toEqual({
      status: "PUBLISHED",
      publishedAt: now,
      externalId: null,
      errorMessage: null,
      metadata: {
        mediaFallbackUsed: false,
        publicationMode: "ASSISTED",
        whatsappDestinationType: "GROUP",
        groupDisplayNameSnapshot: "Grupo A",
        manualConfirmation: true,
        confirmationStrategy: "MANUAL",
        confirmedBy: "user-1",
        confirmedByUserId: "user-1",
        confirmedAt: now.toISOString(),
      },
    });
  });

  it("uses Grupo terminology in the assisted interface", () => {
    expect(ASSISTED_GROUP_INTRO).toContain("Publique no grupo");
    expect(ASSISTED_GROUP_INTRO).not.toContain("Canal");
    expect(assistedGroupConfirmationPrompt("Grupo A")).toBe(
      "Confirma que esta oferta foi publicada no grupo 'Grupo A'?",
    );
  });

  it("keeps the snapshotted group name when the live configuration changes", () => {
    expect(
      groupDisplayNameFromSnapshot(
        { groupDisplayNameSnapshot: "Grupo original" },
        { groupDisplayName: "Grupo renomeado" },
        "Fallback",
      ),
    ).toBe("Grupo original");
  });

  it("converts legacy configuration while preserving operational settings", () => {
    const converted = convertLegacyWhatsAppConfiguration(
      {
        publicationMode: "ASSISTED",
        channelDisplayName: "Grupo legado",
        maxPending: 5,
        sendImage: true,
      },
      "Fallback",
    );

    expect(converted).toMatchObject({
      publicationMode: "ASSISTED",
      whatsappDestinationType: "GROUP",
      groupDisplayName: "Grupo legado",
      maxPendingPublications: 5,
      sendImage: true,
    });
    expect(converted).not.toHaveProperty("channelDisplayName");
    expect(converted).not.toHaveProperty("maxPending");
  });

  it("cancels explicitly and records the authenticated operator", () => {
    expect(assistedCancellationData(null, "user-2", now)).toMatchObject({
      status: "CANCELLED",
      metadata: { skippedByUserId: "user-2" },
    });
  });

  it("sanitizes a manually reported failure reason", () => {
    expect(assistedFailureData(null, "user-3", now, `  ${"x".repeat(600)}  `)).toMatchObject({
      status: "PUBLICATION_FAILED",
      errorMessage: "x".repeat(500),
    });
  });
});
