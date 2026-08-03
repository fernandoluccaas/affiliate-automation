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
      "npm run whatsapp:web:inspect-draft -- --publication-id publication-safe-id --hold-ms 20000",
      "npm run whatsapp:web:preflight -- --publication-id publication-safe-id",
      "npm run whatsapp:web:config-check -- --publication-id publication-safe-id",
      "npm run whatsapp:web:publish -- --publication-id publication-safe-id --confirm-send",
    ]);
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
