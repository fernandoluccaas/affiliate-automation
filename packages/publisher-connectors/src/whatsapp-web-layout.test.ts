import { describe, expect, it } from "vitest";
import {
  classifyWhatsAppMediaCaptionCandidate,
  selectWhatsAppMediaCaptionCandidate,
  type WhatsAppWebCaptionCandidateEvidence,
} from "./whatsapp-web-layout";

function evidence(
  overrides: Partial<WhatsAppWebCaptionCandidateEvidence> = {},
): WhatsAppWebCaptionCandidateEvidence {
  return {
    index: 0,
    existedBeforePreview: false,
    changedSurfaceAfterPreview: false,
    semanticCaption: true,
    visible: true,
    editable: true,
    attached: true,
    ariaHidden: false,
    insideViewport: true,
    topmostAtCenter: true,
    sameTopLevelSurfaceAsPreview: true,
    sameStackingContextAsPreview: true,
    sameStackingContextAsSend: true,
    sameTopLevelSurfaceAsSend: true,
    overlapsPreview: false,
    verticallyAdjacentToPreview: true,
    horizontallyAlignedWithPreview: true,
    ...overrides,
  };
}

describe("active WhatsApp media editor surface", () => {
  it("accepts preview, caption and send in one surface", () => {
    expect(classifyWhatsAppMediaCaptionCandidate(evidence())).toBe(
      "ACTIVE_MEDIA_CAPTION_CANDIDATE",
    );
  });

  it("accepts preview and caption siblings in the same modal", () => {
    expect(
      classifyWhatsAppMediaCaptionCandidate(
        evidence({ sameStackingContextAsPreview: false }),
      ),
    ).toBe("ACTIVE_MEDIA_CAPTION_CANDIDATE");
  });

  it("accepts a related portal in the same stacking contexts", () => {
    expect(
      classifyWhatsAppMediaCaptionCandidate(
        evidence({ sameTopLevelSurfaceAsPreview: false }),
      ),
    ).toBe("ACTIVE_MEDIA_CAPTION_CANDIDATE");
  });

  it("rejects the normal compositor that existed before the preview", () => {
    expect(
      classifyWhatsAppMediaCaptionCandidate(
        evidence({ existedBeforePreview: true, topmostAtCenter: false }),
      ),
    ).toBe("NORMAL_CHAT_COMPOSER_BEHIND_OVERLAY");
  });

  it("allows an existing editable only after unequivocal surface change", () => {
    expect(
      classifyWhatsAppMediaCaptionCandidate(
        evidence({
          existedBeforePreview: true,
          changedSurfaceAfterPreview: true,
        }),
      ),
    ).toBe("ACTIVE_MEDIA_CAPTION_CANDIDATE");
  });

  it("prioritizes a new topmost contenteditable after preview", () => {
    const selected = selectWhatsAppMediaCaptionCandidate([
      evidence({ index: 0, existedBeforePreview: true }),
      evidence({ index: 1 }),
    ]);
    expect(selected).toMatchObject({
      status: "LAYOUT_INSPECTION_READY",
      selectedIndex: 1,
    });
  });

  it("rejects a nearby candidate in another stacking context", () => {
    expect(
      classifyWhatsAppMediaCaptionCandidate(
        evidence({
          sameTopLevelSurfaceAsPreview: false,
          sameStackingContextAsPreview: false,
        }),
      ),
    ).toBe("DIFFERENT_STACKING_CONTEXT");
  });

  it("rejects geometric proximity without caption semantics", () => {
    expect(
      classifyWhatsAppMediaCaptionCandidate(
        evidence({ semanticCaption: false }),
      ),
    ).toBe("NOT_SEMANTIC_CAPTION");
  });

  it("reports two equally valid candidates as ambiguous", () => {
    const selected = selectWhatsAppMediaCaptionCandidate([
      evidence({ index: 0 }),
      evidence({ index: 1 }),
    ]);
    expect(selected.status).toBe("CAPTION_TARGET_AMBIGUOUS");
    expect(selected.selectedIndex).toBeNull();
    expect(selected.decisions.every((decision) => !decision.accepted)).toBe(
      true,
    );
  });

  it("resolves multiple anchors without requiring one simple ancestor", () => {
    const selected = selectWhatsAppMediaCaptionCandidate([
      evidence({
        sameTopLevelSurfaceAsPreview: false,
        sameTopLevelSurfaceAsSend: false,
        sameStackingContextAsPreview: true,
        sameStackingContextAsSend: true,
      }),
    ]);
    expect(selected.status).toBe("LAYOUT_INSPECTION_READY");
  });

  it("fails closed when no candidate is structurally valid", () => {
    const selected = selectWhatsAppMediaCaptionCandidate([
      evidence({ visible: false }),
    ]);
    expect(selected).toMatchObject({
      status: "CAPTION_TARGET_NOT_RESOLVED",
      selectedIndex: null,
    });
  });
});
