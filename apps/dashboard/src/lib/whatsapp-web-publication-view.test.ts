import { describe, expect, it } from "vitest";
import { whatsappWebPublicationView } from "./whatsapp-web-publication-view";

describe("WhatsApp Web publication view", () => {
  it("shows the controlled planning badge and safe inspection commands", () => {
    const view = whatsappWebPublicationView({
      id: "publication-safe-id",
      status: "SCHEDULED",
      metadata: {
        publicationMode: "WEB_EXPERIMENTAL",
        whatsappWebState: "AWAITING_VISUAL_INSPECTION",
        visualInspectionRequired: true,
        visualInspectionConfirmed: false,
        preflightRequired: true,
        realSendAuthorized: false,
        dispatchBlockedReason: "VISUAL_DRAFT_INSPECTION_REQUIRED",
      },
    });

    expect(view).toMatchObject({
      badge: "AGUARDANDO INSPEÇÃO VISUAL",
      state: "AWAITING_VISUAL_INSPECTION",
      visualInspectionRequired: true,
      visualInspectionConfirmed: false,
      realSendAuthorized: false,
      dispatchBlockedReason: "VISUAL_DRAFT_INSPECTION_REQUIRED",
    });
    expect(view?.commands).toEqual([
      "npm run whatsapp:web:inspect-draft -- --publication-id publication-safe-id --hold-ms 30000",
      "npm run whatsapp:web:preflight -- --publication-id publication-safe-id",
      "npm run whatsapp:web:authorize-send -- --publication-id publication-safe-id --expires-in-minutes 15",
      "npm run whatsapp:web:config-check -- --publication-id publication-safe-id",
    ]);
  });

  it("shows waiting state and no operational command for a later Publication", () => {
    const view = whatsappWebPublicationView(
      {
        id: "publication-waiting",
        status: "SCHEDULED",
        metadata: {
          publicationMode: "WEB_EXPERIMENTAL",
          whatsappWebState: "AWAITING_VISUAL_INSPECTION",
        },
      },
      {
        publicationId: "publication-waiting",
        channelId: "channel-web",
        state: "AWAITING_VISUAL_INSPECTION",
        effectiveState: "BLOCKED_BY_ACTIVE_PUBLICATION",
        position: 2,
        active: false,
        blockingPublicationId: "publication-active",
        plannedAt: "2026-08-03T10:00:00.000Z",
        offerVersion: 1,
        authorizationStatus: null,
        authorizationExpiresAt: null,
        fingerprint: "fingerprint",
      },
    );

    expect(view).toMatchObject({
      badge: "AGUARDANDO PUBLICATION ANTERIOR",
      queuePosition: 2,
      blockingPublicationId: "publication-active",
      commands: [],
    });
  });

  it("ignores non-Web publications", () => {
    expect(
      whatsappWebPublicationView({
        id: "telegram-publication",
        status: "PUBLISHED",
        metadata: null,
      }),
    ).toBeNull();
  });
});
