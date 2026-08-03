import { describe, expect, it } from "vitest";
import {
  buildOutgoingMessageBaseline,
  evaluateOutgoingDelivery,
  hashWhatsAppDeliveryValue,
  normalizeWhatsAppDeliveryText,
  type OutgoingMessageCandidate,
} from "./whatsapp-web-delivery-confirmation";

function candidate(
  overrides: Partial<OutgoingMessageCandidate> = {},
): OutgoingMessageCandidate {
  const text =
    overrides.text ?? "Oferta incrível 🔥\nProduto Único\nhttps://meli.la/abc";
  return {
    identityHash: "message-1",
    contentHash: hashWhatsAppDeliveryValue(normalizeWhatsAppDeliveryText(text)),
    order: 1,
    mediaType: "IMAGE",
    deliveryState: "SENT",
    text,
    links: ["https://meli.la/abc"],
    ...overrides,
  };
}

function evaluate(
  baselineCandidates: OutgoingMessageCandidate[],
  currentCandidates: OutgoingMessageCandidate[],
) {
  return evaluateOutgoingDelivery({
    baseline: buildOutgoingMessageBaseline(baselineCandidates),
    candidates: currentCandidates,
    affiliateUrl: "https://meli.la/abc",
    textSnippet: "Produto Único",
    mediaExpected: true,
  });
}

describe("WhatsApp outgoing delivery confirmation", () => {
  it("confirms a new outgoing element with convergent signals", () => {
    expect(evaluate([], [candidate()])).toMatchObject({
      confirmed: true,
      candidateWasNewOrMutated: true,
      stage: "DELIVERY_CONFIRMED",
    });
  });

  it("recognizes an optimistic element reused with a new fingerprint", () => {
    const pending = candidate({
      contentHash: "empty",
      text: "",
      links: [],
      mediaType: "NONE",
      deliveryState: "PENDING",
    });
    expect(evaluate([pending], [candidate()])).toMatchObject({
      confirmed: true,
      candidateWasNewOrMutated: true,
    });
  });

  it("recognizes a fingerprint mutation even when the count does not change", () => {
    const old = candidate({ contentHash: "old", text: "old", links: [] });
    const result = evaluate([old], [candidate()]);
    expect(result.confirmed).toBe(true);
  });

  it("normalizes split text, non-breaking spaces, emojis and line breaks", () => {
    const split = candidate({
      text: "Oferta incrível 🔥\r\nProduto\u00a0Único\nhttps://meli.la/abc",
    });
    expect(evaluate([], [split]).confirmed).toBe(true);
  });

  it("finds an affiliate URL rendered only in a separate link preview", () => {
    const preview = candidate({
      text: "Oferta incrível 🔥\nProduto Único",
      links: ["https://meli.la/abc/"],
    });
    expect(evaluate([], [preview]).affiliateUrlFound).toBe(true);
  });

  it("waits while media has not rendered", () => {
    expect(evaluate([], [candidate({ mediaType: "NONE" })])).toMatchObject({
      confirmed: false,
      stage: "OUTGOING_MEDIA_NOT_CONFIRMED",
    });
  });

  it("waits while text has not rendered", () => {
    expect(evaluate([], [candidate({ text: "", links: [] })])).toMatchObject({
      confirmed: false,
    });
  });

  it("waits for a pending indicator to evolve to sent", () => {
    const pending = candidate({ deliveryState: "PENDING" });
    expect(evaluate([], [pending])).toMatchObject({
      confirmed: false,
      pending: true,
      stage: "OUTGOING_PENDING",
    });
    expect(evaluate([], [candidate({ deliveryState: "SENT" })]).confirmed).toBe(
      true,
    );
  });

  it("rejects an outgoing error indicator", () => {
    expect(evaluate([], [candidate({ deliveryState: "ERROR" })])).toMatchObject(
      {
        confirmed: false,
        errorVisible: true,
        stage: "OUTGOING_ERROR",
      },
    );
  });

  it("does not accept an unchanged message that already existed at baseline", () => {
    const same = candidate();
    expect(evaluate([same], [same])).toMatchObject({
      confirmed: false,
      candidateWasNewOrMutated: false,
    });
  });
});
