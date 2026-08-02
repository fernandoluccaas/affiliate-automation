import { describe, expect, it, vi } from "vitest";
import {
  getWhatsAppWebRuntimeConfig,
  resolveWhatsAppWebProfilePath,
  sanitizeWhatsAppWebProfileKey,
  validateWhatsAppWebPublication,
  WhatsAppGroupsWebPublisher,
  WhatsAppWebStageError,
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
    slowMoMs: 0,
    keepOpenOnError: false,
    keepOpenOnErrorTimeoutMs: 30_000,
    ...overrides,
  };
}

function adapter(
  overrides: Partial<WhatsAppWebPageAdapter> = {},
): WhatsAppWebPageAdapter {
  return {
    navigate: vi.fn().mockResolvedValue(undefined),
    detectAuthenticationState: vi.fn().mockResolvedValue("CONNECTED"),
    waitForAuthenticatedShell: vi.fn().mockResolvedValue({
      found: true,
      stage: "READY_FOR_GROUP_SEARCH",
      strategiesTried: 1,
      visible: true,
      enabled: true,
    }),
    findGlobalSearchTrigger: vi.fn().mockResolvedValue({
      found: true,
      stage: "READY_FOR_GROUP_SEARCH",
      strategiesTried: 1,
      visible: true,
      enabled: true,
    }),
    findGlobalSearchInput: vi.fn().mockResolvedValue({
      found: true,
      stage: "READY_FOR_GROUP_SEARCH",
      strategiesTried: 1,
      visible: true,
      enabled: true,
      editable: true,
    }),
    openGlobalSearch: vi.fn().mockResolvedValue({
      found: true,
      stage: "READY_FOR_GROUP_SEARCH",
      strategiesTried: 1,
      visible: true,
      enabled: true,
      editable: true,
    }),
    fillGlobalSearch: vi.fn().mockResolvedValue({
      found: true,
      stage: "READY_FOR_GROUP_SEARCH",
      strategiesTried: 1,
      visible: true,
      enabled: true,
      editable: true,
    }),
    waitForSearchResults: vi.fn().mockResolvedValue({
      found: true,
      stage: "READY_FOR_GROUP_SEARCH",
      strategiesTried: 1,
      visible: true,
      enabled: true,
    }),
    diagnoseStructure: vi.fn().mockResolvedValue({
      authentication: "CONNECTED",
      shellRecognized: true,
      searchTriggerFound: true,
      searchInputFound: true,
      stage: "READY_FOR_GROUP_SEARCH",
      diagnostics: {
        currentOrigin: "https://web.whatsapp.com",
        interfaceLanguage: "pt",
        shellRecognized: true,
        strategiesTried: 1,
        visible: true,
        enabled: true,
      },
    }),
    locateGroupExact: vi.fn().mockResolvedValue({
      status: "GROUP_FOUND",
      exactMatch: true,
      publishPermission: false,
    }),
    openGroup: vi.fn().mockResolvedValue(undefined),
    verifyOpenedGroup: vi.fn().mockResolvedValue(true),
    verifyPublishPermission: vi.fn().mockResolvedValue(true),
    attachImage: vi.fn().mockResolvedValue({
      attachStrategyUsed: "SET_INPUT_FILES",
      usedFileChooser: false,
      usedSetInputFiles: true,
      previewDetected: true,
    }),
    fillCaption: vi.fn().mockResolvedValue({ captionDetected: true }),
    fillText: vi.fn().mockResolvedValue(undefined),
    inspectPreparedDraft: vi.fn().mockResolvedValue({
      affiliateUrlFound: true,
      affiliateUrlOccurrences: 1,
      textSnippetFound: true,
      mediaFound: true,
      uploadErrorVisible: false,
    }),
    inspectSendTrigger: vi.fn().mockResolvedValue({
      found: true,
      visible: true,
      enabled: true,
      candidateCount: 1,
      strategiesTried: 1,
      outgoingCount: 0,
      stage: "READY_TO_COMMIT_SEND",
    }),
    clickSendTrigger: vi.fn().mockResolvedValue(undefined),
    confirmOutgoingMessage: vi.fn().mockResolvedValue({
      confirmed: true,
      affiliateUrlFound: true,
      affiliateUrlOccurrences: 1,
      textSnippetFound: true,
      mediaFound: true,
      uploadErrorVisible: false,
      stage: "DELIVERY_CONFIRMED",
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
      slowMoMs: 0,
      keepOpenOnError: false,
      keepOpenOnErrorTimeoutMs: 30_000,
      maxPublicationsPerRun: 1,
      autoPauseAfterFirstSuccess: true,
    });
  });

  it("bounds visual debug settings and keeps them opt-in", () => {
    expect(
      getWhatsAppWebRuntimeConfig({
        WHATSAPP_WEB_SLOW_MO_MS: "9999",
        WHATSAPP_WEB_KEEP_OPEN_ON_ERROR: "true",
        WHATSAPP_WEB_KEEP_OPEN_ON_ERROR_TIMEOUT_MS: "999999",
      }),
    ).toMatchObject({
      slowMoMs: 2_000,
      keepOpenOnError: true,
      keepOpenOnErrorTimeoutMs: 60_000,
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

describe("WhatsAppGroupsWebPublisher safe diagnosis and locate", () => {
  it("diagnoses structure without typing, opening, drafting or sending", async () => {
    const page = adapter();
    const close = vi.fn().mockResolvedValue(undefined);
    const release = vi.fn().mockResolvedValue(undefined);
    const browser: WhatsAppWebBrowserLauncher = {
      isAvailable: vi.fn().mockResolvedValue(true),
      launchPersistent: vi.fn().mockResolvedValue({ adapter: page, close }),
    };
    const profileLock: WhatsAppWebProfileLock = {
      acquire: vi.fn().mockResolvedValue({
        key: "lock",
        token: "token",
        acquired: true,
        mode: "redis-url",
        extend: vi.fn().mockResolvedValue(true),
        release,
      }),
    };

    await expect(
      new WhatsAppGroupsWebPublisher({
        config: config(),
        launcher: browser,
        profileLock,
      }).diagnose({ profileKey: "principal" }),
    ).resolves.toMatchObject({
      authentication: "CONNECTED",
      stage: "READY_FOR_GROUP_SEARCH",
    });

    expect(page.fillGlobalSearch).not.toHaveBeenCalled();
    expect(page.openGroup).not.toHaveBeenCalled();
    expect(page.attachImage).not.toHaveBeenCalled();
    expect(page.fillCaption).not.toHaveBeenCalled();
    expect(page.fillText).not.toHaveBeenCalled();
    expect(page.clickSendTrigger).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("preserves a specific selector stage and sanitized diagnostics", async () => {
    const safeDiagnostics = {
      currentOrigin: "https://web.whatsapp.com" as const,
      interfaceLanguage: "pt" as const,
      shellRecognized: true,
      strategiesTried: 7,
      visible: false,
      enabled: false,
      errorCode: "WHATSAPP_WEB_SELECTOR_MISMATCH" as const,
      rootCause: "SEARCH_INPUT_NOT_VISIBLE" as const,
    };
    const page = adapter({
      locateGroupExact: vi.fn().mockResolvedValue({
        status: "GROUP_FOUND",
        exactMatch: true,
        publishPermission: false,
      }),
      openGroup: vi
        .fn()
        .mockRejectedValue(
          new WhatsAppWebStageError(
            "SEARCH_INPUT_NOT_VISIBLE",
            safeDiagnostics,
          ),
        ),
    });

    await expect(
      new WhatsAppGroupsWebPublisher({
        config: config(),
        launcher: launcher(page),
        profileLock: lock(),
      }).locateGroup({
        profileKey: "principal",
        groupDisplayName: "Grupo privado que nao deve aparecer",
      }),
    ).resolves.toMatchObject({
      status: "SELECTOR_MISMATCH",
      stage: "SEARCH_INPUT_NOT_VISIBLE",
      rootCause: "SEARCH_INPUT_NOT_VISIBLE",
      diagnostics: safeDiagnostics,
    });
    expect(JSON.stringify(safeDiagnostics)).not.toContain("Grupo privado");
    expect(page.attachImage).not.toHaveBeenCalled();
    expect(page.fillCaption).not.toHaveBeenCalled();
    expect(page.fillText).not.toHaveBeenCalled();
    expect(page.clickSendTrigger).not.toHaveBeenCalled();
  });

  it("locates an exact writable group and always closes browser and lock", async () => {
    const page = adapter();
    const close = vi.fn().mockResolvedValue(undefined);
    const release = vi.fn().mockResolvedValue(undefined);
    const browser: WhatsAppWebBrowserLauncher = {
      isAvailable: vi.fn().mockResolvedValue(true),
      launchPersistent: vi.fn().mockResolvedValue({ adapter: page, close }),
    };
    const profileLock: WhatsAppWebProfileLock = {
      acquire: vi.fn().mockResolvedValue({
        key: "lock",
        token: "token",
        acquired: true,
        mode: "redis-url",
        extend: vi.fn().mockResolvedValue(true),
        release,
      }),
    };

    await expect(
      new WhatsAppGroupsWebPublisher({
        config: config(),
        launcher: browser,
        profileLock,
      }).locateGroup({
        profileKey: "principal",
        groupDisplayName: "Grupo de Ofertas",
      }),
    ).resolves.toMatchObject({
      status: "GROUP_FOUND",
      exactMatch: true,
      publishPermission: true,
    });
    expect(page.attachImage).not.toHaveBeenCalled();
    expect(page.fillCaption).not.toHaveBeenCalled();
    expect(page.fillText).not.toHaveBeenCalled();
    expect(page.clickSendTrigger).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("closes the browser and releases the lock after a locate failure", async () => {
    const page = adapter({
      locateGroupExact: vi.fn().mockResolvedValue({
        status: "GROUP_NOT_FOUND",
        exactMatch: false,
        publishPermission: false,
        errorCode: "WHATSAPP_WEB_GROUP_NOT_FOUND",
      }),
    });
    const close = vi.fn().mockResolvedValue(undefined);
    const release = vi.fn().mockResolvedValue(undefined);
    const browser: WhatsAppWebBrowserLauncher = {
      isAvailable: vi.fn().mockResolvedValue(true),
      launchPersistent: vi.fn().mockResolvedValue({ adapter: page, close }),
    };
    const profileLock: WhatsAppWebProfileLock = {
      acquire: vi.fn().mockResolvedValue({
        key: "lock",
        token: "token",
        acquired: true,
        mode: "redis-url",
        extend: vi.fn().mockResolvedValue(true),
        release,
      }),
    };

    await new WhatsAppGroupsWebPublisher({
      config: config(),
      launcher: browser,
      profileLock,
    }).locateGroup({
      profileKey: "principal",
      groupDisplayName: "Grupo ausente",
    });

    expect(close).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("does not open an ambiguous result", async () => {
    const page = adapter({
      locateGroupExact: vi.fn().mockResolvedValue({
        status: "GROUP_AMBIGUOUS",
        exactMatch: false,
        publishPermission: false,
        errorCode: "WHATSAPP_WEB_GROUP_AMBIGUOUS",
        stage: "MULTIPLE_EXACT_GROUP_RESULTS",
      }),
    });
    const result = await new WhatsAppGroupsWebPublisher({
      config: config(),
      launcher: launcher(page),
      profileLock: lock(),
    }).locateGroup({
      profileKey: "principal",
      groupDisplayName: "Grupo de Ofertas",
    });

    expect(result.status).toBe("GROUP_AMBIGUOUS");
    expect(page.openGroup).not.toHaveBeenCalled();
    expect(page.clickSendTrigger).not.toHaveBeenCalled();
  });
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
      sendCalled: false,
      stage: "DRY_RUN_READY",
    });
    expect(page.fillText).toHaveBeenCalled();
    expect(page.clickSendTrigger).not.toHaveBeenCalled();
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
    expect(result.stage).toBe("DRAFT_CLEANUP_FAILED");
    expect(result.sendCalled).toBe(false);
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

  it("preserves GROUP_REOPEN_FAILED when the opened header cannot be revalidated", async () => {
    const result = await new WhatsAppGroupsWebPublisher({
      config: config(),
      launcher: launcher(
        adapter({ verifyOpenedGroup: vi.fn().mockResolvedValue(false) }),
      ),
      profileLock: lock(),
    }).dryRun(input());
    expect(result).toMatchObject({
      status: "FAILED",
      stage: "GROUP_REOPEN_FAILED",
      errorCode: "WHATSAPP_WEB_SELECTOR_MISMATCH",
      sendCalled: false,
    });
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
    expect(result.stage).toBe("MEDIA_UPLOAD_FAILED");
  });

  it("prepares image, caption and sanitized media diagnostics", async () => {
    const value = input();
    value.channel.sendImage = true;
    value.imageUrl = "https://cdn.example/image.jpg";
    const page = adapter();
    const result = await new WhatsAppGroupsWebPublisher({
      config: config(),
      launcher: launcher(page),
      profileLock: lock(),
      prepareImage: vi.fn().mockResolvedValue({
        bytes: new Uint8Array([1, 2, 3]),
        contentType: "image/jpeg",
        filename: "offer.jpg",
      }),
    }).dryRun(value);

    expect(result).toMatchObject({
      status: "READY_TO_SEND",
      mediaPrepared: true,
      affiliateUrlConfirmedInDraft: true,
      draftCleared: true,
      sendCalled: false,
      diagnostics: {
        attachStrategyUsed: "SET_INPUT_FILES",
        usedFileChooser: false,
        usedSetInputFiles: true,
        tempFileExists: true,
        tempFileSize: 3,
        tempFileExtension: ".jpg",
        previewDetected: true,
        captionDetected: true,
        draftValidated: true,
        draftCleared: true,
      },
    });
    expect(page.attachImage).toHaveBeenCalledOnce();
    expect(page.fillCaption).toHaveBeenCalledOnce();
    expect(page.clickSendTrigger).not.toHaveBeenCalled();
  });

  it("returns FILE_NOT_FOUND_ON_DISK when the written temp file is absent", async () => {
    const value = input();
    value.channel.sendImage = true;
    value.imageUrl = "https://cdn.example/image.jpg";
    const result = await new WhatsAppGroupsWebPublisher({
      config: config(),
      launcher: launcher(),
      profileLock: lock(),
      prepareImage: vi.fn().mockResolvedValue({
        bytes: new Uint8Array([1]),
        contentType: "image/jpeg",
        filename: "offer.jpg",
      }),
      writeTempFile: vi.fn().mockResolvedValue(undefined),
      statTempFile: vi.fn().mockRejectedValue(new Error("missing")),
    }).dryRun(value);

    expect(result).toMatchObject({
      status: "FAILED",
      stage: "FILE_NOT_FOUND_ON_DISK",
      errorCode: "WHATSAPP_WEB_MEDIA_PREPARATION_FAILED",
      diagnostics: { tempFileExists: false, tempFileExtension: ".jpg" },
    });
  });

  it("returns FILE_NOT_WRITTEN when temporary persistence fails", async () => {
    const value = input();
    value.channel.sendImage = true;
    value.imageUrl = "https://cdn.example/image.jpg";
    const result = await new WhatsAppGroupsWebPublisher({
      config: config(),
      launcher: launcher(),
      profileLock: lock(),
      prepareImage: vi.fn().mockResolvedValue({
        bytes: new Uint8Array([1]),
        contentType: "image/jpeg",
        filename: "offer.jpg",
      }),
      writeTempFile: vi.fn().mockRejectedValue(new Error("disk error")),
    }).dryRun(value);
    expect(result).toMatchObject({
      status: "FAILED",
      stage: "FILE_NOT_WRITTEN",
      errorCode: "WHATSAPP_WEB_MEDIA_PREPARATION_FAILED",
    });
  });

  it("returns FILE_MIME_INVALID for incompatible image metadata", async () => {
    const value = input();
    value.channel.sendImage = true;
    value.imageUrl = "https://cdn.example/image.jpg";
    const result = await new WhatsAppGroupsWebPublisher({
      config: config(),
      launcher: launcher(),
      profileLock: lock(),
      prepareImage: vi.fn().mockResolvedValue({
        bytes: new Uint8Array([1]),
        contentType: "text/plain",
        filename: "offer.jpg",
      }),
    }).dryRun(value);
    expect(result).toMatchObject({
      status: "FAILED",
      stage: "FILE_MIME_INVALID",
      diagnostics: { tempFileExtension: ".jpg" },
    });
  });

  it("returns FILE_SIZE_ZERO for an empty temp file", async () => {
    const value = input();
    value.channel.sendImage = true;
    value.imageUrl = "https://cdn.example/image.jpg";
    const result = await new WhatsAppGroupsWebPublisher({
      config: config(),
      launcher: launcher(),
      profileLock: lock(),
      prepareImage: vi.fn().mockResolvedValue({
        bytes: new Uint8Array(),
        contentType: "image/png",
        filename: "offer.png",
      }),
      writeTempFile: vi.fn().mockResolvedValue(undefined),
      statTempFile: vi.fn().mockResolvedValue({
        size: 0,
        isFile: () => true,
      } as never),
    }).dryRun(value);

    expect(result).toMatchObject({
      status: "FAILED",
      stage: "FILE_SIZE_ZERO",
      diagnostics: { tempFileExists: true, tempFileSize: 0 },
    });
  });

  it("preserves MEDIA_PREVIEW_NOT_FOUND and attempts draft cleanup", async () => {
    const value = input();
    value.channel.sendImage = true;
    value.imageUrl = "https://cdn.example/image.jpg";
    const page = adapter({
      attachImage: vi.fn().mockRejectedValue(
        new WhatsAppWebStageError(
          "MEDIA_PREVIEW_NOT_FOUND",
          {
            currentOrigin: "https://web.whatsapp.com",
            usedFileChooser: true,
            usedSetInputFiles: false,
            previewDetected: false,
            errorCode: "WHATSAPP_WEB_MEDIA_UPLOAD_FAILED",
            rootCause: "MEDIA_PREVIEW_NOT_FOUND",
          },
          "WHATSAPP_WEB_MEDIA_UPLOAD_FAILED",
        ),
      ),
    });
    const result = await new WhatsAppGroupsWebPublisher({
      config: config(),
      launcher: launcher(page),
      profileLock: lock(),
      prepareImage: vi.fn().mockResolvedValue({
        bytes: new Uint8Array([1]),
        contentType: "image/jpeg",
        filename: "offer.jpg",
      }),
    }).dryRun(value);

    expect(result).toMatchObject({
      status: "FAILED",
      stage: "MEDIA_PREVIEW_NOT_FOUND",
      errorCode: "WHATSAPP_WEB_MEDIA_UPLOAD_FAILED",
      draftCleared: true,
      sendCalled: false,
    });
    expect(page.clearDraft).toHaveBeenCalledOnce();
    expect(page.clickSendTrigger).not.toHaveBeenCalled();
  });

  it("preserves CAPTION_INPUT_NOT_FOUND", async () => {
    const value = input();
    value.channel.sendImage = true;
    value.imageUrl = "https://cdn.example/image.jpg";
    const page = adapter({
      fillCaption: vi.fn().mockRejectedValue(
        new WhatsAppWebStageError(
          "CAPTION_INPUT_NOT_FOUND",
          {
            currentOrigin: "https://web.whatsapp.com",
            captionDetected: false,
            errorCode: "WHATSAPP_WEB_DRAFT_VALIDATION_FAILED",
            rootCause: "CAPTION_INPUT_NOT_FOUND",
          },
          "WHATSAPP_WEB_DRAFT_VALIDATION_FAILED",
        ),
      ),
    });
    const result = await new WhatsAppGroupsWebPublisher({
      config: config(),
      launcher: launcher(page),
      profileLock: lock(),
      prepareImage: vi.fn().mockResolvedValue({
        bytes: new Uint8Array([1]),
        contentType: "image/jpeg",
        filename: "offer.jpg",
      }),
    }).dryRun(value);

    expect(result.stage).toBe("CAPTION_INPUT_NOT_FOUND");
    expect(result.errorCode).toBe("WHATSAPP_WEB_DRAFT_VALIDATION_FAILED");
    expect(result.sendCalled).toBe(false);
  });

  it("preserves DRAFT_VALIDATION_FAILED and clears the partial draft", async () => {
    const page = adapter({
      inspectPreparedDraft: vi.fn().mockResolvedValue({
        affiliateUrlFound: false,
        affiliateUrlOccurrences: 0,
        textSnippetFound: true,
        mediaFound: true,
        uploadErrorVisible: false,
      }),
    });
    const result = await new WhatsAppGroupsWebPublisher({
      config: config(),
      launcher: launcher(page),
      profileLock: lock(),
    }).dryRun(input());

    expect(result).toMatchObject({
      status: "FAILED",
      stage: "DRAFT_VALIDATION_FAILED",
      errorCode: "WHATSAPP_WEB_DRAFT_VALIDATION_FAILED",
      draftCleared: true,
      sendCalled: false,
    });
    expect(page.clearDraft).toHaveBeenCalledOnce();
    expect(page.clickSendTrigger).not.toHaveBeenCalled();
  });
});

describe("WhatsAppGroupsWebPublisher protected send", () => {
  it("preflights the exact draft and send trigger without clicking", async () => {
    const page = adapter();
    const result = await new WhatsAppGroupsWebPublisher({
      config: config(),
      launcher: launcher(page),
      profileLock: lock(),
    }).preflight(input());

    expect(result).toMatchObject({
      status: "READY_TO_COMMIT_SEND",
      groupExactMatch: true,
      affiliateUrlConfirmedInDraft: true,
      sendTriggerFound: true,
      sendTriggerVisible: true,
      sendTriggerEnabled: true,
      sendCalled: false,
      draftCleared: true,
    });
    expect(page.clickSendTrigger).not.toHaveBeenCalled();
    expect(page.clearDraft).toHaveBeenCalledOnce();
  });

  it("fails preflight safely when the trigger is ambiguous", async () => {
    const page = adapter({
      inspectSendTrigger: vi.fn().mockResolvedValue({
        found: true,
        visible: false,
        enabled: false,
        candidateCount: 2,
        strategiesTried: 1,
        outgoingCount: 0,
        stage: "SEND_TRIGGER_AMBIGUOUS",
      }),
    });
    const result = await new WhatsAppGroupsWebPublisher({
      config: config(),
      launcher: launcher(page),
      profileLock: lock(),
    }).preflight(input());

    expect(result).toMatchObject({
      status: "FAILED",
      stage: "SEND_TRIGGER_AMBIGUOUS",
      sendCalled: false,
      draftCleared: true,
    });
    expect(page.clickSendTrigger).not.toHaveBeenCalled();
  });

  it("fails preflight if the open group changes before commit", async () => {
    const page = adapter({
      verifyOpenedGroup: vi
        .fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false),
    });
    const result = await new WhatsAppGroupsWebPublisher({
      config: config(),
      launcher: launcher(page),
      profileLock: lock(),
    }).preflight(input());

    expect(result).toMatchObject({
      status: "FAILED",
      stage: "PRE_SEND_GROUP_MISMATCH",
      sendCalled: false,
    });
    expect(page.clickSendTrigger).not.toHaveBeenCalled();
  });

  it("does not click when the durable pre-send marker cannot be persisted", async () => {
    const page = adapter();
    const result = await new WhatsAppGroupsWebPublisher({
      config: config({ dryRun: false }),
      launcher: launcher(page),
      profileLock: lock(),
      recordSendState: vi.fn().mockRejectedValue(new Error("database down")),
    }).publish(input());

    expect(result).toMatchObject({
      status: "FAILED",
      sendWasClicked: false,
      stage: "SEND_STATE_PERSIST_FAILED",
      errorCode: "WHATSAPP_WEB_SEND_STATE_PERSIST_FAILED",
    });
    expect(page.clickSendTrigger).not.toHaveBeenCalled();
    expect(page.clearDraft).toHaveBeenCalledOnce();
  });

  it("refuses real send while dry-run protection is active", async () => {
    const page = adapter();
    const result = await new WhatsAppGroupsWebPublisher({
      config: config(),
      launcher: launcher(page),
      profileLock: lock(),
    }).publish(input());
    expect(result.errorCode).toBe("WHATSAPP_WEB_DISABLED");
    expect(page.clickSendTrigger).not.toHaveBeenCalled();
  });

  it("requires an unchanged successful dry-run fingerprint", async () => {
    const value = input();
    value.channel.groupDisplayName = "Grupo alterado";
    const result = await new WhatsAppGroupsWebPublisher({
      config: config({ dryRun: false }),
      launcher: launcher(),
      profileLock: lock(),
      recordSendState: vi.fn().mockResolvedValue(undefined),
    }).publish(value);
    expect(result.errorCode).toBe("WHATSAPP_WEB_DRAFT_VALIDATION_FAILED");
  });

  it("publishes only after visual confirmation", async () => {
    const recordSendState = vi.fn().mockResolvedValue(undefined);
    const result = await new WhatsAppGroupsWebPublisher({
      config: config({ dryRun: false }),
      launcher: launcher(),
      profileLock: lock(),
      recordSendState,
    }).publish(input());
    expect(result).toMatchObject({ status: "PUBLISHED", sendWasClicked: true });
    expect(result.metadata).toMatchObject({
      confirmationStrategy: "VISUAL_NEW_OUTGOING_MESSAGE",
    });
    expect(recordSendState).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "SEND_CLICK_STARTED",
        sendWasClicked: false,
        deliveryUncertain: true,
      }),
    );
    expect(recordSendState).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "SEND_CLICK_COMPLETED",
        sendWasClicked: true,
      }),
    );
  });

  it("blocks automatic retry when confirmation is inconclusive after click", async () => {
    const page = adapter({
      confirmOutgoingMessage: vi.fn().mockResolvedValue({
        confirmed: false,
        affiliateUrlFound: false,
        affiliateUrlOccurrences: 0,
        textSnippetFound: false,
        mediaFound: false,
        uploadErrorVisible: false,
        stage: "DELIVERY_CONFIRMATION_TIMEOUT",
      }),
    });
    const result = await new WhatsAppGroupsWebPublisher({
      config: config({ dryRun: false }),
      launcher: launcher(page),
      profileLock: lock(),
      recordSendState: vi.fn().mockResolvedValue(undefined),
    }).publish(input());
    expect(result).toMatchObject({
      status: "DELIVERY_UNCERTAIN",
      sendWasClicked: true,
      errorCode: "WHATSAPP_WEB_DELIVERY_UNCERTAIN",
    });
  });

  it("classifies an error after click initiation as delivery uncertain", async () => {
    const page = adapter({
      clickSendTrigger: vi
        .fn()
        .mockRejectedValue(new Error("WHATSAPP_WEB_SEND_FAILED")),
    });
    const result = await new WhatsAppGroupsWebPublisher({
      config: config({ dryRun: false }),
      launcher: launcher(page),
      profileLock: lock(),
      recordSendState: vi.fn().mockResolvedValue(undefined),
    }).publish(input());
    expect(result).toMatchObject({
      status: "DELIVERY_UNCERTAIN",
      sendWasClicked: false,
      errorCode: "WHATSAPP_WEB_DELIVERY_UNCERTAIN",
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
