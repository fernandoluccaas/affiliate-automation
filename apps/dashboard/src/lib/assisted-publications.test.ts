import { describe, expect, it } from "vitest";
import {
  assistedCancellationData,
  assistedConfirmationData,
  assistedFailureData,
} from "./assisted-publications";

describe("assisted publication transitions", () => {
  const now = new Date("2026-08-02T12:00:00.000Z");

  it("confirms manually without fabricating an external message id", () => {
    expect(assistedConfirmationData({ mediaFallbackUsed: false }, "user-1", now)).toEqual({
      status: "PUBLISHED",
      publishedAt: now,
      externalId: null,
      errorMessage: null,
      metadata: {
        mediaFallbackUsed: false,
        publicationMode: "ASSISTED",
        confirmationStrategy: "MANUAL",
        confirmedByUserId: "user-1",
        confirmedAt: now.toISOString(),
      },
    });
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
