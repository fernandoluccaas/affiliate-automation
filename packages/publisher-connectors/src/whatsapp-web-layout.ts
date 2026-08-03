import type {
  WhatsAppWebLayoutCandidateDecision,
  WhatsAppWebLayoutCandidateReason,
} from "./whatsapp-web-types";

export type WhatsAppWebCaptionCandidateEvidence = {
  index: number;
  existedBeforePreview: boolean;
  changedSurfaceAfterPreview: boolean;
  semanticCaption: boolean;
  visible: boolean;
  editable: boolean;
  attached: boolean;
  ariaHidden: boolean;
  insideViewport: boolean;
  topmostAtCenter: boolean;
  sameTopLevelSurfaceAsPreview: boolean;
  sameStackingContextAsPreview: boolean;
  sameStackingContextAsSend: boolean;
  sameTopLevelSurfaceAsSend: boolean;
  overlapsPreview: boolean;
  verticallyAdjacentToPreview: boolean;
  horizontallyAlignedWithPreview: boolean;
};

export function classifyWhatsAppMediaCaptionCandidate(
  evidence: WhatsAppWebCaptionCandidateEvidence,
): WhatsAppWebLayoutCandidateReason {
  if (evidence.existedBeforePreview && !evidence.changedSurfaceAfterPreview) {
    return evidence.topmostAtCenter
      ? "EXISTED_BEFORE_MEDIA_EDITOR"
      : "NORMAL_CHAT_COMPOSER_BEHIND_OVERLAY";
  }
  if (!evidence.semanticCaption) return "NOT_SEMANTIC_CAPTION";
  if (
    !evidence.visible ||
    !evidence.editable ||
    !evidence.attached ||
    evidence.ariaHidden
  ) {
    return "NOT_VISIBLE_OR_EDITABLE";
  }
  if (!evidence.insideViewport) return "OUTSIDE_VIEWPORT";
  if (!evidence.topmostAtCenter) return "NOT_TOPMOST";
  const visuallyRelated =
    evidence.sameTopLevelSurfaceAsPreview ||
    (evidence.sameStackingContextAsPreview &&
      (evidence.overlapsPreview ||
        (evidence.verticallyAdjacentToPreview &&
          evidence.horizontallyAlignedWithPreview)));
  if (!visuallyRelated) return "DIFFERENT_STACKING_CONTEXT";
  if (
    !evidence.sameStackingContextAsSend &&
    !evidence.sameTopLevelSurfaceAsSend
  ) {
    return "NOT_ASSOCIATED_WITH_MEDIA_CONTROLS";
  }
  return "ACTIVE_MEDIA_CAPTION_CANDIDATE";
}

export function selectWhatsAppMediaCaptionCandidate(
  candidates: WhatsAppWebCaptionCandidateEvidence[],
): {
  selectedIndex: number | null;
  status:
    | "LAYOUT_INSPECTION_READY"
    | "CAPTION_TARGET_NOT_RESOLVED"
    | "CAPTION_TARGET_AMBIGUOUS";
  decisions: WhatsAppWebLayoutCandidateDecision[];
} {
  const classified = candidates.map((candidate) => ({
    candidate,
    reason: classifyWhatsAppMediaCaptionCandidate(candidate),
  }));
  const accepted = classified.filter(
    ({ reason }) => reason === "ACTIVE_MEDIA_CAPTION_CANDIDATE",
  );
  const ambiguous = accepted.length > 1;
  return {
    selectedIndex:
      accepted.length === 1 ? (accepted[0]?.candidate.index ?? null) : null,
    status: ambiguous
      ? "CAPTION_TARGET_AMBIGUOUS"
      : accepted.length === 1
        ? "LAYOUT_INSPECTION_READY"
        : "CAPTION_TARGET_NOT_RESOLVED",
    decisions: classified.map(({ candidate, reason }) => ({
      index: candidate.index,
      accepted: !ambiguous && reason === "ACTIVE_MEDIA_CAPTION_CANDIDATE",
      reason:
        ambiguous && reason === "ACTIVE_MEDIA_CAPTION_CANDIDATE"
          ? "CAPTION_TARGET_AMBIGUOUS"
          : reason,
    })),
  };
}
