import { describe, expect, it, vi } from "vitest";
import {
  getWhatsAppWebRuntimeConfig,
  resolveWhatsAppWebProfilePath,
  sanitizeWhatsAppWebProfileKey,
  validateWhatsAppWebPublication,
  WhatsAppGroupsWebPublisher,
  whatsappWebConfigurationFingerprint,
  type WhatsAppWebBrowserLauncher,
  type WhatsAppWebPageAdapter,
  type WhatsAppWebProfileLock,
  type WhatsAppWebPublicationInput,
  type WhatsAppWebRuntimeConfig,
} from "./index";

function config(
  overrides: Partial<WhatsAppWebRuntimeConfig> = {},
): WhatsAppWebRuntimeConfig {
  return {
    enabled: true,
    dryRun: true,
    headless: true,
    userDataRoot: ".local/whatsapp-web",
    debugRoot: ".local/whatsapp-debug",
    debugScreenshots: false,
    actionTimeoutMs: 30_000,
    navigationTimeoutMs: 60_000,
    confirmationTimeoutMs: 20_000,
    profileLockTtlMs: 180_000,
    maxPublicationsPerRun: 1,
    autoPauseAfterFirstSuccess: true,
    allowTextFallback: true,
    ...overrides,
  };
}

function adapter(
  overrides: Partial<WhatsAppWebPageAdapter> = {},
): WhatsAppWebPageAdapter {
  return {
    navigate: vi.fn().mockResolvedValue(undefined),
    detectAuthenticationState: vi.fn().mockResolvedValue("CONNECTED"),
    locateGroupExact: vi.fn().mockResolvedValue({
      status: "GROUP_FOUND",
      exactMatch: true,
      publishPermission: false,
    }),
    openGroup: vi.fn().mockResolvedValue(undefined),
    verifyOpenedGroup: vi.fn().mockResolvedValue(true),
    verifyPublishPermission: vi.fn().mockResolvedValue(true),
    attachImage: vi.fn().mockResolvedValue(undefined),
    fillCaption: vi.fn().mockResolvedValue(undefined),
    fillText: vi.fn().mockResolvedValue(undefined),
    inspectPreparedDraft: vi.fn().mockResolvedValue({
      affiliateUrlFound: true,
      textSnippetFound: true,
      mediaFound: true,
    }),
    send: vi.fn().mockResolvedValue(undefined),
    confirmOutgoingMessage: vi.fn().mockResolvedValue({
      confirmed: true,
      affiliateUrlFound: true,
      textSnippetFound: true,
      mediaFound: true,
    }),
    clearDraft: vi.fn().mockResolvedValue(undefined),
    isDraftClear: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function lock(
  options: {
    acquired?: boolean;
    failureReason?: "REDIS_UNAVAILABLE" | "LOCK_ALREADY_HELD";
  } = {},
): WhatsAppWebProfileLock {
  return {
    acquire: vi.fn().mockResolvedValue({
      key: "lock",
      token: "owner-token",
      acquired: options.acquired ?? true,
      mode:
        options.failureReason === "REDIS_UNAVAILABLE"
          ? "unavailable"
          : "redis-url",
      failureReason: options.failureReason,
      extend: vi.fn().mockResolvedValue(true),
      release: vi.fn().mockResolvedValue(undefined),
    }),
  };
}

function launcher(
  pageAdapter = adapter(),
  available = true,
): WhatsAppWebBrowserLauncher {
  return {
    isAvailable: vi.fn().mockResolvedValue(available),
    launchPersistent: vi.fn().mockResolvedValue({
      adapter: pageAdapter,
      close: vi.fn().mockResolvedValue(undefined),
    }),
  };
}

function input(): WhatsAppWebPublicationInput {
  const channel = {
    channelId: "channel-1",
    channelType: "WHATSAPP_GROUPS",
    channelEnabled: true,
    channelPaused: false,
    publicationMode: "WEB_EXPERIMENTAL",
    groupDisplayName: "Grupo de Ofertas",
    webProfileKey: "principal",
    webAutomationEnabled: true,
    webAutomationOwnershipConfirmed: true,
    webAutomationConfirmedAt: "2026-08-02T00:00:00.000Z",
    sendImage: false,
    lastSuccessfulDryRunAt: "2026-08-02T00:00:00.000Z",
    lastSuccessfulDryRunConfigurationFingerprint: "",
  };
  channel.lastSuccessfulDryRunConfigurationFingerprint =
    whatsappWebConfigurationFingerprint(channel);
  return {
    publicationId: "publication-1",
    offerId: "offer-1",
    destinationType: "GROUP" as const,
    message: "Oferta validada\nProduto unico\nhttps://meli.la/abc",
    affiliateUrl: "https://meli.la/abc",
    title: "Produto unico",
    imageUrl: null,
    channel,
  };
}

describe("WhatsApp Web profile safety and defaults", () => {
  it.each(["../principal", "a/b", "a\\b", "C:\\perfil", "x\u0000y", ""])(
    "rejects unsafe profile key %j",
    (value) => {
      expect(() => sanitizeWhatsAppWebProfileKey(value)).toThrow(
        "WHATSAPP_WEB_PROFILE_KEY_INVALID",
      );
    },
  );

  it("maps a logical key below the configured root", () => {
    expect(
      resolveWhatsAppWebProfilePath(".local/whatsapp-web", "principal"),
    ).toMatch(/whatsapp-web[\\/]principal$/);
  });

  it("uses non-sending defaults", () => {
    const result = getWhatsAppWebRuntimeConfig({});
    expect(result).toMatchObject({
      enabled: false,
      dryRun: true,
      headless: false,
      maxPublicationsPerRun: 1,
      autoPauseAfterFirstSuccess: true,
    });
  });
});

describe("WhatsAppGroupsWebPublisher health", () => {
  it("does not launch when feature flag is false", async () => {
    const browser = launcher();
    const result = await new WhatsAppGroupsWebPublisher({
      config: config({ enabled: false }),
      launcher: browser,
    }).healthCheck({ profileKey: "principal" });
    expect(result.status).toBe("DISABLED");
    expect(browser.launchPersistent).not.toHaveBeenCalled();
  });

  it("reports unavailable Chromium without launching", async () => {
    const result = await new WhatsAppGroupsWebPublisher({
      config: config(),
      launcher: launcher(adapter(), false),
    }).healthCheck({ profileKey: "principal" });
    expect(result.status).toBe("BROWSER_UNAVAILABLE");
  });

  it.each([
    ["REDIS_UNAVAILABLE", "REDIS_UNAVAILABLE"],
    ["LOCK_ALREADY_HELD", "PROFILE_IN_USE"],
  ] as const)("reports lock failure %s", async (failureReason, status) => {
    const result = await new WhatsAppGroupsWebPublisher({
      config: config(),
      launcher: launcher(),
      profileLock: lock({ acquired: false, failureReason }),
    }).healthCheck({ profileKey: "principal" });
    expect(result.status).toBe(status);
  });

  it.each(["CONNECTED", "LOGIN_REQUIRED", "UNEXPECTED_STATE"] as const)(
    "detects authenticated state %s",
    async (state) => {
      const result = await new WhatsAppGroupsWebPublisher({
        config: config(),
        launcher: launcher(
          adapter({
            detectAuthenticationState: vi.fn().mockResolvedValue(state),
          }),
        ),
        profileLock: lock(),
      }).healthCheck({ profileKey: "principal" });
      expect(result.status).toBe(state);
    },
  );
});

describe("WhatsAppGroupsWebPublisher dry run", () => {
  it("requires ownership before opening the browser", async () => {
    const browser = launcher();
    const value = input();
    value.channel.webAutomationOwnershipConfirmed = false;
    const result = await new WhatsAppGroupsWebPublisher({
      config: config(),
      launcher: browser,
      profileLock: lock(),
    }).dryRun(value);
    expect(result.errorCode).toBe("WHATSAPP_WEB_OWNERSHIP_NOT_CONFIRMED");
    expect(browser.launchPersistent).not.toHaveBeenCalled();
  });

  it("prepares and clears a draft without ever calling send", async () => {
    const page = adapter();
    const result = await new WhatsAppGroupsWebPublisher({
      config: config(),
      launcher: launcher(page),
      profileLock: lock(),
    }).dryRun(input());
    expect(result).toMatchObject({
      status: "READY_TO_SEND",
      affiliateUrlConfirmedInDraft: true,
      draftCleared: true,
    });
    expect(page.fillText).toHaveBeenCalled();
    expect(page.send).not.toHaveBeenCalled();
    expect(page.clearDraft).toHaveBeenCalled();
  });

  it("fails safely when draft cleanup cannot be verified", async () => {
    const result = await new WhatsAppGroupsWebPublisher({
      config: config(),
      launcher: launcher(
        adapter({ isDraftClear: vi.fn().mockResolvedValue(false) }),
      ),
      profileLock: lock(),
    }).dryRun(input());
    expect(result.errorCode).toBe("WHATSAPP_WEB_DRAFT_CLEANUP_FAILED");
  });

  it("returns exact group failures without clicking anything", async () => {
    const page = adapter({
      locateGroupExact: vi.fn().mockResolvedValue({
        status: "GROUP_AMBIGUOUS",
        exactMatch: false,
        publishPermission: false,
        errorCode: "WHATSAPP_WEB_GROUP_AMBIGUOUS",
      }),
    });
    const result = await new WhatsAppGroupsWebPublisher({
      config: config(),
      launcher: launcher(page),
      profileLock: lock(),
    }).dryRun(input());
    expect(result.errorCode).toBe("WHATSAPP_WEB_GROUP_AMBIGUOUS");
    expect(page.openGroup).not.toHaveBeenCalled();
  });

  it("uses a text fallback when media preparation fails", async () => {
    const value = input();
    value.channel.sendImage = true;
    value.imageUrl = "https://cdn.example/image.jpg";
    const page = adapter();
    const result = await new WhatsAppGroupsWebPublisher({
      config: config(),
      launcher: launcher(page),
      profileLock: lock(),
      prepareImage: vi.fn().mockRejectedValue(new Error("invalid")),
    }).dryRun(value);
    expect(result).toMatchObject({
      status: "READY_TO_SEND",
      mediaFallbackUsed: true,
      mediaPrepared: false,
    });
    expect(page.fillText).toHaveBeenCalled();
  });

  it("fails when invalid media has no fallback", async () => {
    const value = input();
    value.channel.sendImage = true;
    value.imageUrl = "https://cdn.example/image.jpg";
    const result = await new WhatsAppGroupsWebPublisher({
      config: config({ allowTextFallback: false }),
      launcher: launcher(),
      profileLock: lock(),
      prepareImage: vi.fn().mockRejectedValue(new Error("invalid")),
    }).dryRun(value);
    expect(result.errorCode).toBe("WHATSAPP_WEB_MEDIA_PREPARATION_FAILED");
  });
});

describe("WhatsAppGroupsWebPublisher protected send", () => {
  it("refuses real send while dry-run protection is active", async () => {
    const page = adapter();
    const result = await new WhatsAppGroupsWebPublisher({
      config: config(),
      launcher: launcher(page),
      profileLock: lock(),
    }).publish(input());
    expect(result.errorCode).toBe("WHATSAPP_WEB_DISABLED");
    expect(page.send).not.toHaveBeenCalled();
  });

  it("requires an unchanged successful dry-run fingerprint", async () => {
    const value = input();
    value.channel.groupDisplayName = "Grupo alterado";
    const result = await new WhatsAppGroupsWebPublisher({
      config: config({ dryRun: false }),
      launcher: launcher(),
      profileLock: lock(),
    }).publish(value);
    expect(result.errorCode).toBe("WHATSAPP_WEB_DRAFT_VALIDATION_FAILED");
  });

  it("publishes only after visual confirmation", async () => {
    const result = await new WhatsAppGroupsWebPublisher({
      config: config({ dryRun: false }),
      launcher: launcher(),
      profileLock: lock(),
    }).publish(input());
    expect(result).toMatchObject({ status: "PUBLISHED", sendWasClicked: true });
    expect(result.metadata).toMatchObject({
      confirmationStrategy: "VISUAL_OUTGOING_MESSAGE",
      confirmedAffiliateUrl: "https://meli.la/abc",
    });
  });

  it("blocks automatic retry when confirmation is inconclusive after click", async () => {
    const page = adapter({
      confirmOutgoingMessage: vi.fn().mockResolvedValue({
        confirmed: false,
        affiliateUrlFound: false,
        textSnippetFound: false,
        mediaFound: false,
      }),
    });
    const result = await new WhatsAppGroupsWebPublisher({
      config: config({ dryRun: false }),
      launcher: launcher(page),
      profileLock: lock(),
    }).publish(input());
    expect(result).toMatchObject({
      status: "DELIVERY_UNCERTAIN",
      sendWasClicked: true,
      errorCode: "WHATSAPP_WEB_DELIVERY_UNCERTAIN",
    });
  });

  it("does not classify a failure before click as delivery uncertain", async () => {
    const page = adapter({
      send: vi.fn().mockRejectedValue(new Error("WHATSAPP_WEB_SEND_FAILED")),
    });
    const result = await new WhatsAppGroupsWebPublisher({
      config: config({ dryRun: false }),
      launcher: launcher(page),
      profileLock: lock(),
    }).publish(input());
    expect(result).toMatchObject({
      status: "FAILED",
      sendWasClicked: false,
      errorCode: "WHATSAPP_WEB_SEND_FAILED",
    });
  });
});

describe("WhatsApp Web immutable snapshot validation", () => {
  it("requires the affiliate URL exactly once and HTTPS", () => {
    const value = input();
    value.message += "\nhttps://meli.la/abc";
    expect(() => validateWhatsAppWebPublication(value)).toThrow(
      "WHATSAPP_WEB_DRAFT_VALIDATION_FAILED",
    );
    value.message = "Oferta\nhttp://meli.la/abc";
    value.affiliateUrl = "http://meli.la/abc";
    expect(() => validateWhatsAppWebPublication(value)).toThrow(
      "WHATSAPP_WEB_DRAFT_VALIDATION_FAILED",
    );
  });

  it.each([
    "<b>Oferta</b>\nhttps://meli.la/abc",
    "Oferta #publi\nhttps://meli.la/abc",
  ])("rejects unsafe commercial snapshot", (message) => {
    expect(() =>
      validateWhatsAppWebPublication({ ...input(), message }),
    ).toThrow("WHATSAPP_WEB_DRAFT_VALIDATION_FAILED");
  });
});
