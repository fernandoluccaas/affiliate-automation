import { describe, expect, it } from "vitest";
import { resolveAttribution, type AttributionCandidate } from "./attribution";

const occurredAt = new Date("2026-08-05T12:00:00.000Z");
const now = new Date("2026-08-05T13:00:00.000Z");

function click(overrides: Partial<AttributionCandidate> = {}): AttributionCandidate {
  return {
    clickId: "click-1",
    affiliateLinkId: "link-1",
    publicationId: "publication-1",
    offerId: "offer-1",
    channelId: "channel-1",
    createdAt: new Date("2026-08-05T11:00:00.000Z"),
    subId: "sub-1",
    ...overrides,
  };
}

function decide(overrides: Partial<Parameters<typeof resolveAttribution>[0]> = {}) {
  return resolveAttribution({ occurredAt, now, windowHours: 168, candidates: [click()], ...overrides });
}

describe("deterministic attribution", () => {
  it("matches an explicit click reference first", () => {
    expect(decide({ clickReference: "click-1", subId: "sub-1" })).toMatchObject({
      status: "ATTRIBUTED_EXACT",
      method: "EXTERNAL_CLICK_ID",
      matchQuality: "EXACT",
      clickId: "click-1",
    });
  });

  it.each([
    [{ subId: "sub-1" }, "SUB_ID", "ATTRIBUTED_BY_SUB_ID"],
    [{ affiliateLinkId: "link-1" }, "AFFILIATE_LINK", "ATTRIBUTED_EXACT"],
    [{ publicationId: "publication-1" }, "PUBLICATION", "ATTRIBUTED_EXACT"],
    [{ offerId: "offer-1" }, "OFFER", "ATTRIBUTED_EXACT"],
  ] as const)("matches by deterministic reference", (references, method, status) => {
    expect(decide(references)).toMatchObject({ method, status, clickId: "click-1" });
  });

  it("uses last click only when the available candidate is unique", () => {
    expect(decide()).toMatchObject({ status: "ATTRIBUTED_LAST_CLICK", method: "LAST_CLICK" });
  });

  it("does not attribute equivalent candidates silently", () => {
    const decision = decide({ candidates: [click(), click({ clickId: "click-2", createdAt: new Date("2026-08-05T11:30:00Z") })] });
    expect(decision).toMatchObject({ status: "UNATTRIBUTED_AMBIGUOUS", method: "NONE" });
    expect(decision.metadata.candidatesConsidered).toBe(2);
  });

  it("treats multiple matches for an explicit reference as ambiguous", () => {
    const decision = decide({ clickReference: "click-1", candidates: [click(), click({ publicationId: "publication-2" })] });
    expect(decision).toMatchObject({ status: "UNATTRIBUTED_AMBIGUOUS" });
  });

  it("rejects clicks outside the attribution window", () => {
    const decision = decide({ windowHours: 1, candidates: [click({ createdAt: new Date("2026-08-05T10:59:59.999Z") })] });
    expect(decision).toMatchObject({ status: "UNATTRIBUTED_NO_CLICK", clickId: null });
  });

  it("accepts the exact attribution-window boundary", () => {
    const decision = decide({ windowHours: 1, candidates: [click({ createdAt: new Date("2026-08-05T11:00:00.000Z") })] });
    expect(decision).toMatchObject({ status: "ATTRIBUTED_LAST_CLICK" });
  });

  it("returns no click when none exists", () => {
    expect(decide({ candidates: [] })).toMatchObject({ status: "UNATTRIBUTED_NO_CLICK", method: "NONE" });
  });

  it("rejects automatic reprocessing of an already attributed conversion", () => {
    expect(decide({ existingStatus: "ATTRIBUTED_EXACT" })).toMatchObject({
      status: "REJECTED_INVALID_DATA",
      metadata: { reason: "CONVERSION_ALREADY_ATTRIBUTED" },
    });
  });

  it("records the explicit timezone instant and currency remains outside attribution", () => {
    const decision = resolveAttribution({
      occurredAt: new Date("2026-08-05T09:00:00-03:00"),
      now,
      windowHours: 168,
      candidates: [click()],
    });
    expect(decision.attributionWindowHours).toBe(168);
    expect(decision.metadata).not.toHaveProperty("currency");
  });

  it("rejects an invalid window", () => {
    expect(decide({ windowHours: 0 })).toMatchObject({ status: "REJECTED_INVALID_DATA" });
  });
});
