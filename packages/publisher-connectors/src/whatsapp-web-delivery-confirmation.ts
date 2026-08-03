import { createHash } from "node:crypto";

export type OutgoingDeliveryState = "PENDING" | "SENT" | "ERROR" | "UNKNOWN";

export type OutgoingMessageFingerprint = {
  identityHash: string;
  contentHash: string;
  order: number;
  mediaType: "IMAGE" | "VIDEO" | "OTHER" | "NONE";
  deliveryState: OutgoingDeliveryState;
};

export type OutgoingMessageBaseline = {
  capturedAt: string;
  count: number;
  digest: string;
  messages: OutgoingMessageFingerprint[];
};

export type OutgoingMessageCandidate = OutgoingMessageFingerprint & {
  text: string;
  links: string[];
  observedTimestampMs?: number | null;
};

export type OutgoingDeliveryEvaluation = {
  confirmed: boolean;
  candidateFound: boolean;
  candidateWasNewOrMutated: boolean;
  affiliateUrlFound: boolean;
  affiliateUrlOccurrences: number;
  textSnippetFound: boolean;
  mediaFound: boolean;
  pending: boolean;
  sent: boolean;
  errorVisible: boolean;
  timestampCoherent: boolean;
  stage:
    | "OUTGOING_MESSAGE_NOT_FOUND"
    | "OUTGOING_CANDIDATE_FOUND"
    | "OUTGOING_AFFILIATE_URL_NOT_CONFIRMED"
    | "OUTGOING_TEXT_NOT_CONFIRMED"
    | "OUTGOING_MEDIA_NOT_CONFIRMED"
    | "OUTGOING_PENDING"
    | "OUTGOING_ERROR"
    | "OUTGOING_SENT"
    | "DELIVERY_CONFIRMED";
};

export function normalizeWhatsAppDeliveryText(value: string) {
  return value
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}

export function hashWhatsAppDeliveryValue(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function buildOutgoingMessageBaseline(
  messages: OutgoingMessageFingerprint[],
  capturedAt = new Date().toISOString(),
): OutgoingMessageBaseline {
  const sanitized = messages.map((message) => ({ ...message }));
  return {
    capturedAt,
    count: sanitized.length,
    digest: hashWhatsAppDeliveryValue(
      JSON.stringify(
        sanitized.map(
          ({ identityHash, contentHash, mediaType, deliveryState }) => [
            identityHash,
            contentHash,
            mediaType,
            deliveryState,
          ],
        ),
      ),
    ),
    messages: sanitized,
  };
}

function normalizedComparableUrl(value: string) {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return value.trim().replace(/\/$/, "");
  }
}

function occurrenceCount(haystack: string, needle: string) {
  if (!needle) return 0;
  return haystack.split(needle).length - 1;
}

function isNewOrMutated(
  baseline: OutgoingMessageBaseline,
  candidate: OutgoingMessageCandidate,
) {
  const previous = baseline.messages.find(
    (message) => message.identityHash === candidate.identityHash,
  );
  if (!previous) return true;
  return (
    previous.contentHash !== candidate.contentHash ||
    previous.mediaType !== candidate.mediaType ||
    previous.deliveryState !== candidate.deliveryState
  );
}

export function evaluateOutgoingDelivery(input: {
  baseline: OutgoingMessageBaseline;
  candidates: OutgoingMessageCandidate[];
  affiliateUrl: string;
  textSnippet: string;
  mediaExpected: boolean;
  requireMutation?: boolean;
  sentAfter?: Date;
}): OutgoingDeliveryEvaluation {
  const expectedUrl = normalizedComparableUrl(input.affiliateUrl);
  const expectedSnippet = normalizeWhatsAppDeliveryText(input.textSnippet);
  let strongest: OutgoingDeliveryEvaluation = {
    confirmed: false,
    candidateFound: false,
    candidateWasNewOrMutated: false,
    affiliateUrlFound: false,
    affiliateUrlOccurrences: 0,
    textSnippetFound: false,
    mediaFound: false,
    pending: false,
    sent: false,
    errorVisible: false,
    timestampCoherent: false,
    stage: "OUTGOING_MESSAGE_NOT_FOUND",
  };

  for (const candidate of input.candidates) {
    const text = normalizeWhatsAppDeliveryText(candidate.text);
    const comparableLinks = candidate.links.map(normalizedComparableUrl);
    const textUrlOccurrences = occurrenceCount(text, expectedUrl);
    const linkOccurrences = comparableLinks.filter(
      (value) => value === expectedUrl,
    ).length;
    const affiliateUrlOccurrences = Math.max(
      textUrlOccurrences,
      linkOccurrences,
    );
    const affiliateUrlFound = affiliateUrlOccurrences > 0;
    const textSnippetFound = text.includes(expectedSnippet);
    if (!affiliateUrlFound && !textSnippetFound) continue;

    const candidateWasNewOrMutated = isNewOrMutated(input.baseline, candidate);
    const mediaFound = input.mediaExpected
      ? candidate.mediaType !== "NONE"
      : true;
    const errorVisible = candidate.deliveryState === "ERROR";
    const pending = candidate.deliveryState === "PENDING";
    const sent = candidate.deliveryState === "SENT";
    const timestampCoherent =
      candidate.observedTimestampMs == null ||
      !input.sentAfter ||
      candidate.observedTimestampMs >= input.sentAfter.getTime() - 60_000;
    const mutationSatisfied =
      input.requireMutation === false || candidateWasNewOrMutated;
    const confirmed =
      mutationSatisfied &&
      affiliateUrlFound &&
      textSnippetFound &&
      mediaFound &&
      timestampCoherent &&
      !errorVisible &&
      !pending;
    const stage = errorVisible
      ? "OUTGOING_ERROR"
      : !mutationSatisfied
        ? "OUTGOING_CANDIDATE_FOUND"
        : !affiliateUrlFound
          ? "OUTGOING_AFFILIATE_URL_NOT_CONFIRMED"
          : !textSnippetFound
            ? "OUTGOING_TEXT_NOT_CONFIRMED"
            : !mediaFound
              ? "OUTGOING_MEDIA_NOT_CONFIRMED"
              : pending
                ? "OUTGOING_PENDING"
                : confirmed
                  ? "DELIVERY_CONFIRMED"
                  : sent
                    ? "OUTGOING_SENT"
                    : "OUTGOING_CANDIDATE_FOUND";

    const evaluation: OutgoingDeliveryEvaluation = {
      confirmed,
      candidateFound: true,
      candidateWasNewOrMutated,
      affiliateUrlFound,
      affiliateUrlOccurrences,
      textSnippetFound,
      mediaFound,
      pending,
      sent,
      errorVisible,
      timestampCoherent,
      stage,
    };
    strongest = evaluation;
    if (confirmed || errorVisible) return evaluation;
  }
  return strongest;
}
