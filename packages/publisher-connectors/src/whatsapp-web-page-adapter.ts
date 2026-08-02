import type { Locator, Page } from "playwright";
import {
  WHATSAPP_WEB_URL,
  whatsappWebAccessibleAliases,
  whatsappWebExactGroupResultSelectors,
  whatsappWebStableSelectors,
} from "./whatsapp-web-selectors";
import {
  WhatsAppWebStageError,
  type AuthenticationState,
  type OutgoingMessageConfirmation,
  type PreparedDraftInspection,
  type WhatsAppGroupLocationResult,
  type WhatsAppWebControlResult,
  type WhatsAppWebDiagnosticStage,
  type WhatsAppWebDraftCleanupResult,
  type WhatsAppWebErrorCode,
  type WhatsAppWebMediaAttachmentResult,
  type WhatsAppWebPageAdapter,
  type WhatsAppWebSafeDiagnostics,
  type WhatsAppWebSendTriggerInspection,
  type WhatsAppWebStructureDiagnosticResult,
} from "./whatsapp-web-types";

function normalizedText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function errorCodeForDiagnosticStage(
  stage: WhatsAppWebDiagnosticStage,
): WhatsAppWebErrorCode {
  if (
    stage === "FILE_NOT_WRITTEN" ||
    stage === "FILE_NOT_FOUND_ON_DISK" ||
    stage === "FILE_SIZE_ZERO" ||
    stage === "FILE_MIME_INVALID"
  ) {
    return "WHATSAPP_WEB_MEDIA_PREPARATION_FAILED";
  }
  if (
    stage === "ATTACH_TRIGGER_NOT_FOUND" ||
    stage === "ATTACH_MENU_NOT_FOUND" ||
    stage === "IMAGE_OPTION_NOT_FOUND" ||
    stage === "FILE_INPUT_NOT_FOUND" ||
    stage === "FILE_CHOOSER_NOT_OPENED" ||
    stage === "MEDIA_UPLOAD_FAILED" ||
    stage === "MEDIA_PREVIEW_NOT_FOUND"
  ) {
    return "WHATSAPP_WEB_MEDIA_UPLOAD_FAILED";
  }
  if (stage === "DRAFT_CLEANUP_FAILED") {
    return "WHATSAPP_WEB_DRAFT_CLEANUP_FAILED";
  }
  if (stage.startsWith("PRE_SEND_")) {
    return "WHATSAPP_WEB_PRE_SEND_VALIDATION_FAILED";
  }
  if (stage.startsWith("SEND_TRIGGER_") || stage === "SEND_CLICK_FAILED") {
    return "WHATSAPP_WEB_SEND_TRIGGER_FAILED";
  }
  if (
    stage === "CAPTION_INPUT_NOT_FOUND" ||
    stage === "CAPTION_NOT_EDITABLE" ||
    stage === "CAPTION_INPUT_RECREATED" ||
    stage === "CAPTION_CONTENT_LOST" ||
    stage === "CAPTION_CONTENT_MISMATCH" ||
    stage === "DRAFT_VALIDATION_FAILED"
  ) {
    return "WHATSAPP_WEB_DRAFT_VALIDATION_FAILED";
  }
  return "WHATSAPP_WEB_SELECTOR_MISMATCH";
}

type LocatedControl = WhatsAppWebControlResult & {
  locator?: Locator;
  matched?: boolean;
};

export class PlaywrightWhatsAppWebPageAdapter implements WhatsAppWebPageAdapter {
  private globalSearchInput: Locator | null = null;
  private exactGroupResult: Locator | null = null;
  private lastLocationDiagnostics: WhatsAppWebSafeDiagnostics | null = null;
  private validatedSendTrigger: Locator | null = null;

  constructor(
    private readonly page: Page,
    private readonly confirmationTimeoutMs: number,
    private readonly actionTimeoutMs = 30_000,
  ) {}

  async navigate() {
    await this.page.goto(WHATSAPP_WEB_URL, { waitUntil: "domcontentloaded" });
  }

  async detectAuthenticationState(): Promise<AuthenticationState> {
    const deadline = Date.now() + this.actionTimeoutMs;
    do {
      const shell = await this.findAuthenticatedShellOnce();
      if (shell.found) return "CONNECTED";
      const qrVisible = await this.page
        .locator(whatsappWebStableSelectors.qrCanvas)
        .first()
        .isVisible()
        .catch(() => false);
      const loginVisible = await this.firstVisible([
        this.page.getByText("Log in with phone number", { exact: false }),
        this.page.getByText("Entrar com número de telefone", { exact: false }),
        this.page.getByText("Entrar com numero de telefone", { exact: false }),
        this.page.getByText("Link with phone number", { exact: false }),
        this.page.getByText("Vincular con el número de teléfono", {
          exact: false,
        }),
      ]);
      if (qrVisible || loginVisible) return "LOGIN_REQUIRED";
      await this.page.waitForTimeout(200);
    } while (Date.now() < deadline);
    return "UNEXPECTED_STATE";
  }

  async waitForAuthenticatedShell(): Promise<WhatsAppWebControlResult> {
    const deadline = Date.now() + this.actionTimeoutMs;
    let stableObservations = 0;
    let strategiesTried = 0;
    do {
      const shell = await this.findAuthenticatedShellOnce();
      strategiesTried = Math.max(strategiesTried, shell.strategiesTried);
      if (shell.found) {
        const overlay = await this.anyVisible(
          whatsappWebStableSelectors.loadingOverlays.map((selector) =>
            this.page.locator(selector),
          ),
        );
        stableObservations = overlay ? 0 : stableObservations + 1;
        if (stableObservations >= 2) return shell;
      } else {
        stableObservations = 0;
      }
      await this.page.waitForTimeout(200);
    } while (Date.now() < deadline);
    return this.controlFailure(
      "AUTHENTICATED_SHELL_NOT_RECOGNIZED",
      strategiesTried || whatsappWebStableSelectors.authenticatedShell.length,
    );
  }

  async findGlobalSearchTrigger(): Promise<WhatsAppWebControlResult> {
    return this.findGlobalSearchTriggerControl();
  }

  async findGlobalSearchInput(): Promise<WhatsAppWebControlResult> {
    return this.findGlobalSearchInputControl();
  }

  async openGlobalSearch(): Promise<WhatsAppWebControlResult> {
    const existing = await this.findGlobalSearchInputControl();
    if (existing.found) return existing;

    const trigger = await this.findGlobalSearchTriggerControl();
    if (!trigger.found || !trigger.locator) return trigger;
    if (!trigger.visible || !trigger.enabled) {
      return this.controlFailure(
        "SEARCH_TRIGGER_NOT_INTERACTABLE",
        trigger.strategiesTried,
        trigger,
      );
    }
    try {
      await trigger.locator.click();
    } catch {
      return this.controlFailure(
        "SEARCH_OPEN_FAILED",
        trigger.strategiesTried,
        trigger,
      );
    }

    const deadline = Date.now() + this.actionTimeoutMs;
    do {
      const input = await this.findGlobalSearchInputControl();
      if (input.found) return input;
      await this.page.waitForTimeout(150);
    } while (Date.now() < deadline);
    return this.controlFailure(
      "SEARCH_INPUT_NOT_FOUND",
      trigger.strategiesTried,
    );
  }

  async fillGlobalSearch(text: string): Promise<WhatsAppWebControlResult> {
    const opened = await this.openGlobalSearch();
    if (!opened.found || !this.globalSearchInput) return opened;
    if (!opened.visible)
      return this.controlFailure(
        "SEARCH_INPUT_NOT_VISIBLE",
        opened.strategiesTried,
        opened,
      );
    if (!opened.editable)
      return this.controlFailure(
        "SEARCH_INPUT_NOT_EDITABLE",
        opened.strategiesTried,
        opened,
      );
    try {
      await this.globalSearchInput.fill("");
      await this.globalSearchInput.fill(text);
      return opened;
    } catch {
      return this.controlFailure(
        "SEARCH_INPUT_NOT_EDITABLE",
        opened.strategiesTried,
        opened,
      );
    }
  }

  async waitForSearchResults(): Promise<WhatsAppWebControlResult> {
    const deadline = Date.now() + this.actionTimeoutMs;
    let containerRecognized = false;
    do {
      const container = await this.firstVisible(
        whatsappWebStableSelectors.searchResults.map((selector) =>
          this.page.locator(selector),
        ),
      );
      if (!container) {
        await this.page.waitForTimeout(150);
        continue;
      }
      containerRecognized = true;
      const candidateCount = await this.countFirstAvailableStrategy(
        whatsappWebStableSelectors.genericSearchCandidate,
      );
      const empty = await this.firstVisible(
        whatsappWebAccessibleAliases.emptySearch.map((name) =>
          this.page.getByText(name, { exact: false }),
        ),
      );
      if (candidateCount > 0 || empty) {
        return {
          found: true,
          stage: "READY_FOR_GROUP_SEARCH",
          strategiesTried: whatsappWebStableSelectors.searchResults.length,
          visible: true,
          enabled: true,
        };
      }
      await this.page.waitForTimeout(150);
    } while (Date.now() < deadline);
    return this.controlFailure(
      containerRecognized
        ? "SEARCH_RESULTS_NOT_READY"
        : "SEARCH_RESULTS_CONTAINER_NOT_FOUND",
      whatsappWebStableSelectors.searchResults.length,
    );
  }

  async diagnoseStructure(): Promise<WhatsAppWebStructureDiagnosticResult> {
    const startedAt = Date.now();
    const authentication = await this.detectAuthenticationState();
    if (authentication !== "CONNECTED") {
      return {
        authentication,
        shellRecognized: false,
        searchTriggerFound: false,
        searchInputFound: false,
        stage: "AUTHENTICATED_SHELL_NOT_RECOGNIZED",
        diagnostics: await this.safeDiagnostics({
          shellRecognized: false,
          durationMs: Date.now() - startedAt,
          rootCause: "AUTHENTICATED_SHELL_NOT_RECOGNIZED",
        }),
      };
    }
    const shell = await this.waitForAuthenticatedShell();
    if (!shell.found)
      return this.diagnosticFailure(authentication, shell, startedAt);

    const inputBefore = await this.findGlobalSearchInputControl();
    if (inputBefore.found) {
      return this.diagnosticReady(
        authentication,
        true,
        false,
        inputBefore,
        startedAt,
      );
    }
    const trigger = await this.findGlobalSearchTriggerControl();
    if (!trigger.found)
      return this.diagnosticFailure(authentication, trigger, startedAt);
    const inputAfter = await this.openGlobalSearch();
    if (!inputAfter.found)
      return this.diagnosticFailure(
        authentication,
        inputAfter,
        startedAt,
        true,
      );
    return this.diagnosticReady(
      authentication,
      true,
      true,
      inputAfter,
      startedAt,
    );
  }

  async locateGroupExact(name: string): Promise<WhatsAppGroupLocationResult> {
    const startedAt = Date.now();
    const shell = await this.waitForAuthenticatedShell();
    if (!shell.found) return this.locationSelectorFailure(shell, startedAt);
    const search = await this.fillGlobalSearch(name);
    if (!search.found) return this.locationSelectorFailure(search, startedAt);
    const results = await this.waitForSearchResults();
    if (!results.found) return this.locationSelectorFailure(results, startedAt);

    const exact = await this.findExactGroupResult(name);
    const diagnostics = await this.safeDiagnostics({
      shellRecognized: true,
      strategiesTried: exact.strategiesTried,
      candidateCount: exact.candidateCount,
      exactMatchCount: exact.count,
      visible: exact.visible,
      enabled: exact.enabled,
      ...(search.editable !== undefined ? { editable: search.editable } : {}),
      durationMs: Date.now() - startedAt,
    });
    this.lastLocationDiagnostics = diagnostics;
    if (exact.count === 0) {
      return {
        status: "GROUP_NOT_FOUND",
        exactMatch: false,
        publishPermission: false,
        errorCode: "WHATSAPP_WEB_GROUP_NOT_FOUND",
        stage: "EXACT_GROUP_RESULT_NOT_FOUND",
        rootCause: "EXACT_GROUP_RESULT_NOT_FOUND",
        diagnostics: {
          ...diagnostics,
          errorCode: "WHATSAPP_WEB_GROUP_NOT_FOUND",
          rootCause: "EXACT_GROUP_RESULT_NOT_FOUND",
        },
      };
    }
    if (exact.count > 1) {
      return {
        status: "GROUP_AMBIGUOUS",
        exactMatch: false,
        publishPermission: false,
        errorCode: "WHATSAPP_WEB_GROUP_AMBIGUOUS",
        stage: "MULTIPLE_EXACT_GROUP_RESULTS",
        rootCause: "MULTIPLE_EXACT_GROUP_RESULTS",
        diagnostics: {
          ...diagnostics,
          errorCode: "WHATSAPP_WEB_GROUP_AMBIGUOUS",
          rootCause: "MULTIPLE_EXACT_GROUP_RESULTS",
        },
      };
    }
    if (!exact.locator || !exact.visible || !exact.enabled) {
      return this.locationSelectorFailure(
        this.controlFailure(
          "GROUP_RESULT_NOT_INTERACTABLE",
          exact.strategiesTried,
          {
            visible: exact.visible,
            enabled: exact.enabled,
          },
        ),
        startedAt,
      );
    }
    this.exactGroupResult = exact.locator;
    return {
      status: "GROUP_FOUND",
      exactMatch: true,
      publishPermission: false,
      stage: "GROUP_FOUND",
      diagnostics,
    };
  }

  async openGroup(name: string) {
    if (!this.exactGroupResult) {
      throw await this.stageError("GROUP_RESULT_NOT_INTERACTABLE");
    }
    try {
      await this.exactGroupResult.click();
    } catch {
      throw await this.stageError("GROUP_OPEN_FAILED");
    }
    const header = await this.waitForOpenedHeader(name);
    if (!header.found) throw await this.stageError(header.stage, header);
  }

  async verifyOpenedGroup(name: string) {
    return (await this.waitForOpenedHeader(name)).found;
  }

  async verifyPublishPermission() {
    const deadline = Date.now() + this.actionTimeoutMs;
    do {
      const composer = await this.findWritableComposer();
      if (composer.found) return true;
      if (await this.hasReadOnlySignal()) return false;
      await this.page.waitForTimeout(150);
    } while (Date.now() < deadline);
    throw await this.stageError("COMPOSER_NOT_FOUND");
  }

  async attachImage(path: string): Promise<WhatsAppWebMediaAttachmentResult> {
    const diagnostic = {
      usedFileChooser: false,
      usedSetInputFiles: false,
      previewDetected: false,
    };
    const main = this.page.locator("#main, main");
    const attach = await this.firstVisible([
      ...whatsappWebAccessibleAliases.attach.map((name) =>
        main.getByRole("button", { name, exact: true }),
      ),
      ...whatsappWebStableSelectors.attachTrigger.map((selector) =>
        this.page.locator(selector),
      ),
    ]);
    if (!attach) {
      throw await this.stageError("ATTACH_TRIGGER_NOT_FOUND", {}, diagnostic);
    }

    const directChooserPromise = this.page
      .waitForEvent("filechooser", { timeout: 1_500 })
      .catch(() => null);
    try {
      await attach.click();
    } catch {
      throw await this.stageError("MEDIA_UPLOAD_FAILED", {}, diagnostic);
    }

    const directChooser = await directChooserPromise;
    if (directChooser) {
      diagnostic.usedFileChooser = true;
      try {
        await directChooser.setFiles(path);
      } catch {
        throw await this.stageError("FILE_NOT_WRITTEN", {}, diagnostic);
      }
      return this.waitForMediaPreview("DIRECT_FILE_CHOOSER", diagnostic);
    }

    const attachMenu = await this.waitForVisible(
      whatsappWebStableSelectors.attachMenu.map((selector) =>
        this.page.locator(selector),
      ),
      2_000,
    );
    const imageOption = await this.findImageOption();
    if (imageOption) {
      const chooserPromise = this.page
        .waitForEvent("filechooser", { timeout: 2_000 })
        .catch(() => null);
      try {
        await imageOption.click();
      } catch {
        throw await this.stageError("IMAGE_OPTION_NOT_FOUND", {}, diagnostic);
      }
      const chooser = await chooserPromise;
      if (chooser) {
        diagnostic.usedFileChooser = true;
        try {
          await chooser.setFiles(path);
        } catch {
          throw await this.stageError("FILE_NOT_WRITTEN", {}, diagnostic);
        }
        return this.waitForMediaPreview(
          "IMAGE_OPTION_FILE_CHOOSER",
          diagnostic,
        );
      }
    }

    const fileInput = await this.waitForImageFileInput(2_000);
    if (fileInput) {
      diagnostic.usedSetInputFiles = true;
      try {
        await fileInput.setInputFiles(path);
      } catch {
        throw await this.stageError("FILE_NOT_WRITTEN", {}, diagnostic);
      }
      return this.waitForMediaPreview("SET_INPUT_FILES", diagnostic);
    }

    if (!attachMenu) {
      throw await this.stageError("ATTACH_MENU_NOT_FOUND", {}, diagnostic);
    }
    if (!imageOption) {
      throw await this.stageError("IMAGE_OPTION_NOT_FOUND", {}, diagnostic);
    }
    throw await this.stageError("FILE_CHOOSER_NOT_OPENED", {}, diagnostic);
  }

  async fillCaption(input: {
    text: string;
    affiliateUrl: string;
    textSnippet: string;
  }) {
    await this.waitForStableMediaEditor();
    const expected = normalizedText(input.text);
    let lastStage: WhatsAppWebDiagnosticStage = "CAPTION_INPUT_NOT_FOUND";
    let observedLength = 0;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const caption = await this.findCaptionInput();
      if (!caption) {
        lastStage = "CAPTION_INPUT_NOT_FOUND";
        await this.page.waitForTimeout(200);
        continue;
      }
      const visible = await caption.isVisible().catch(() => false);
      const editable = await caption.isEditable().catch(() => false);
      if (!visible || !editable) {
        lastStage = "CAPTION_NOT_EDITABLE";
        if (attempt < 2) {
          await this.page.waitForTimeout(200);
          continue;
        }
        throw await this.stageError(
          lastStage,
          {},
          {
            captionDetected: true,
            captionInputFound: true,
            captionInputVisible: visible,
            captionInputEditable: editable,
            captionFillAttempts: attempt,
            captionStable: false,
            captionLengthExpected: expected.length,
            captionLengthObserved: 0,
          },
        );
      }
      try {
        const originalElement = await caption.elementHandle();
        await caption.focus();
        await caption.fill("");
        await caption.fill(input.text);
        await this.page.waitForTimeout(250);
        const stillAttached = originalElement
          ? await originalElement
              .evaluate((element) => element.isConnected)
              .catch(() => false)
          : false;
        await originalElement?.dispose().catch(() => undefined);
        const currentCaption = await this.findCaptionInput();
        const observed = currentCaption
          ? await this.readEditableText(currentCaption)
          : "";
        observedLength = observed.length;
        const affiliateUrlOccurrenceCount =
          observed.split(input.affiliateUrl).length - 1;
        const titleSnippetConfirmed = observed.includes(
          normalizedText(input.textSnippet),
        );

        if (!stillAttached) {
          lastStage = "CAPTION_INPUT_RECREATED";
        } else if (!observed) {
          lastStage = "CAPTION_CONTENT_LOST";
        } else if (
          observed !== expected ||
          affiliateUrlOccurrenceCount !== 1 ||
          !titleSnippetConfirmed
        ) {
          lastStage = "CAPTION_CONTENT_MISMATCH";
        } else {
          await this.page.waitForTimeout(250);
          const stableCaption = await this.findCaptionInput();
          const stableText = stableCaption
            ? await this.readEditableText(stableCaption)
            : "";
          const stableAffiliateUrlOccurrenceCount =
            stableText.split(input.affiliateUrl).length - 1;
          if (
            stableText === expected &&
            stableAffiliateUrlOccurrenceCount === 1 &&
            stableText.includes(normalizedText(input.textSnippet))
          ) {
            return {
              captionDetected: true as const,
              captionInputFound: true as const,
              captionInputVisible: true as const,
              captionInputEditable: true as const,
              captionFillAttempts: attempt,
              captionStable: true as const,
              captionLengthExpected: expected.length,
              captionLengthObserved: expected.length,
              affiliateUrlOccurrenceCount: stableAffiliateUrlOccurrenceCount,
              titleSnippetConfirmed: true as const,
            };
          }
          lastStage = stableText
            ? "CAPTION_CONTENT_MISMATCH"
            : "CAPTION_CONTENT_LOST";
          observedLength = stableText.length;
        }
      } catch {
        lastStage = "CAPTION_NOT_EDITABLE";
        if (attempt < 2) continue;
        throw await this.stageError(
          lastStage,
          {},
          {
            captionDetected: true,
            captionInputFound: true,
            captionInputVisible: true,
            captionInputEditable: true,
            captionFillAttempts: attempt,
            captionStable: false,
            captionLengthExpected: expected.length,
            captionLengthObserved: 0,
          },
        );
      }

      if (attempt < 2) await this.page.waitForTimeout(200);
    }

    throw await this.stageError(
      lastStage,
      {},
      {
        captionDetected: true,
        captionInputFound: lastStage !== "CAPTION_INPUT_NOT_FOUND",
        captionInputVisible: lastStage !== "CAPTION_INPUT_NOT_FOUND",
        captionInputEditable:
          lastStage !== "CAPTION_INPUT_NOT_FOUND" &&
          lastStage !== "CAPTION_NOT_EDITABLE",
        captionFillAttempts: 2,
        captionStable: false,
        captionLengthExpected: expected.length,
        captionLengthObserved: observedLength,
      },
    );
  }

  async fillText(text: string) {
    const composer = await this.findWritableComposer();
    if (!composer.found || !composer.locator)
      throw new Error("WHATSAPP_WEB_NO_PUBLISH_PERMISSION");
    await composer.locator.fill(text);
  }

  async inspectPreparedDraft(input: {
    affiliateUrl: string;
    textSnippet: string;
    expectedText: string;
    mediaExpected: boolean;
  }): Promise<PreparedDraftInspection> {
    const draftControl = input.mediaExpected
      ? await this.findCaptionInput()
      : (await this.findWritableComposer()).locator;
    const text = draftControl ? await this.readEditableText(draftControl) : "";
    const mediaFound = Boolean(
      await this.firstVisible(
        whatsappWebStableSelectors.mediaPreview.map((selector) =>
          this.page.locator(selector),
        ),
      ),
    );
    const expectedText = normalizedText(input.expectedText);
    const expectedSnapshotFound = text === expectedText;
    const affiliateUrlOccurrences = text.split(input.affiliateUrl).length - 1;
    const mediaSurface = await this.visibleMediaSurface();
    let uploadErrorVisible = false;
    const uploadInProgressVisible = await this.hasMediaUploadInProgress();
    if (mediaSurface) {
      for (const alias of whatsappWebAccessibleAliases.uploadError) {
        const candidate = mediaSurface.getByText(alias, { exact: false });
        if (
          (await candidate.count().catch(() => 0)) > 0 &&
          (await candidate
            .first()
            .isVisible()
            .catch(() => false))
        ) {
          uploadErrorVisible = true;
          break;
        }
      }
    }
    return {
      affiliateUrlFound: affiliateUrlOccurrences === 1,
      affiliateUrlOccurrences,
      textSnippetFound:
        expectedSnapshotFound &&
        text.includes(normalizedText(input.textSnippet)),
      mediaFound: input.mediaExpected ? mediaFound : true,
      uploadErrorVisible,
      uploadInProgressVisible,
      captionStable: expectedSnapshotFound,
      captionLengthExpected: expectedText.length,
      captionLengthObserved: expectedSnapshotFound
        ? expectedText.length
        : text.length,
    };
  }

  async inspectSendTrigger(input: {
    mediaExpected: boolean;
  }): Promise<WhatsAppWebSendTriggerInspection> {
    this.validatedSendTrigger = null;
    const scopes = input.mediaExpected
      ? await this.visibleMediaSurfaces()
      : [
          await this.firstVisible([
            this.page.locator("#main footer"),
            this.page.locator("main footer"),
          ]),
        ].filter((value): value is Locator => value !== null);
    const outgoingCount = await this.page
      .locator(whatsappWebStableSelectors.outgoingMessage)
      .count()
      .catch(() => 0);
    if (scopes.length === 0) {
      return {
        found: false,
        visible: false,
        enabled: false,
        candidateCount: 0,
        strategiesTried: 0,
        outgoingCount,
        stage: "SEND_TRIGGER_NOT_FOUND",
      };
    }

    let strategiesTried = 0;
    for (const scope of scopes) {
      const strategies = [
        ...whatsappWebAccessibleAliases.send.map((name) =>
          scope.getByRole("button", { name, exact: true }),
        ),
        ...whatsappWebStableSelectors.mediaSendTrigger.map((selector) =>
          scope.locator(selector),
        ),
      ];
      for (const strategy of strategies) {
        strategiesTried += 1;
        const count = await strategy.count().catch(() => 0);
        if (count === 0) continue;
        if (count !== 1) {
          return {
            found: true,
            visible: false,
            enabled: false,
            candidateCount: count,
            strategiesTried,
            outgoingCount,
            stage: "SEND_TRIGGER_AMBIGUOUS",
          };
        }
        const candidate = strategy.first();
        const visible = await candidate.isVisible().catch(() => false);
        const enabled = await candidate.isEnabled().catch(() => false);
        if (!visible) {
          return {
            found: true,
            visible,
            enabled,
            candidateCount: 1,
            strategiesTried,
            outgoingCount,
            stage: "SEND_TRIGGER_NOT_VISIBLE",
          };
        }
        if (!enabled) {
          return {
            found: true,
            visible,
            enabled,
            candidateCount: 1,
            strategiesTried,
            outgoingCount,
            stage: "SEND_TRIGGER_DISABLED",
          };
        }
        this.validatedSendTrigger = candidate;
        return {
          found: true,
          visible: true,
          enabled: true,
          candidateCount: 1,
          strategiesTried,
          outgoingCount,
          stage: "READY_TO_COMMIT_SEND",
        };
      }
    }
    if (input.mediaExpected) {
      const editorBoundStrategies = [
        ...whatsappWebAccessibleAliases.send.map((name) =>
          this.page.getByRole("button", { name, exact: true }),
        ),
        ...whatsappWebStableSelectors.mediaSendTrigger.map((selector) =>
          this.page.locator(selector),
        ),
      ];
      for (const strategy of editorBoundStrategies) {
        strategiesTried += 1;
        const count = await strategy.count().catch(() => 0);
        const candidates: Locator[] = [];
        for (let index = 0; index < count; index += 1) {
          const candidate = strategy.nth(index);
          if (await this.isInsideCurrentMediaEditor(candidate)) {
            candidates.push(candidate);
          }
        }
        if (candidates.length === 0) continue;
        if (candidates.length !== 1) {
          return {
            found: true,
            visible: false,
            enabled: false,
            candidateCount: candidates.length,
            strategiesTried,
            outgoingCount,
            stage: "SEND_TRIGGER_AMBIGUOUS",
          };
        }
        const candidate = candidates[0]!;
        const visible = await candidate.isVisible().catch(() => false);
        const enabled = await candidate.isEnabled().catch(() => false);
        if (!visible || !enabled) {
          return {
            found: true,
            visible,
            enabled,
            candidateCount: 1,
            strategiesTried,
            outgoingCount,
            stage: visible
              ? "SEND_TRIGGER_DISABLED"
              : "SEND_TRIGGER_NOT_VISIBLE",
          };
        }
        this.validatedSendTrigger = candidate;
        return {
          found: true,
          visible: true,
          enabled: true,
          candidateCount: 1,
          strategiesTried,
          outgoingCount,
          stage: "READY_TO_COMMIT_SEND",
        };
      }
    }
    return {
      found: false,
      visible: false,
      enabled: false,
      candidateCount: 0,
      strategiesTried,
      outgoingCount,
      stage: "SEND_TRIGGER_NOT_FOUND",
    };
  }

  async clickSendTrigger() {
    const button = this.validatedSendTrigger;
    if (!button) {
      throw await this.stageError("SEND_TRIGGER_NOT_INTERACTABLE", {});
    }
    const visible = await button.isVisible().catch(() => false);
    const enabled = await button.isEnabled().catch(() => false);
    if (!visible || !enabled) {
      throw await this.stageError(
        visible ? "SEND_TRIGGER_DISABLED" : "SEND_TRIGGER_NOT_VISIBLE",
        {},
        { candidateCount: 1, visible, enabled },
      );
    }
    try {
      await button.click();
    } catch {
      throw await this.stageError(
        "SEND_CLICK_FAILED",
        {},
        {
          candidateCount: 1,
          visible: true,
          enabled: true,
        },
      );
    }
  }

  async confirmOutgoingMessage(input: {
    affiliateUrl: string;
    textSnippet: string;
    mediaExpected: boolean;
    sentAfter: Date;
    outgoingCountBefore: number;
  }): Promise<OutgoingMessageConfirmation> {
    const deadline = Date.now() + this.confirmationTimeoutMs;
    let lastStage: OutgoingMessageConfirmation["stage"] =
      "OUTGOING_MESSAGE_NOT_FOUND";
    do {
      const outgoing = this.page.locator(
        whatsappWebStableSelectors.outgoingMessage,
      );
      const count = await outgoing.count().catch(() => 0);
      for (let index = input.outgoingCountBefore; index < count; index += 1) {
        const candidate = outgoing.nth(index);
        if (!(await candidate.isVisible().catch(() => false))) continue;
        const text = normalizedText(await candidate.innerText());
        const affiliateUrlFound = text.includes(input.affiliateUrl);
        const textSnippetFound = text.includes(
          normalizedText(input.textSnippet),
        );
        const mediaFound = input.mediaExpected
          ? (await candidate
              .locator("img, [data-testid*='media']")
              .count()
              .catch(() => 0)) > 0
          : true;
        lastStage = !affiliateUrlFound
          ? "OUTGOING_AFFILIATE_URL_NOT_CONFIRMED"
          : !textSnippetFound
            ? "OUTGOING_TEXT_NOT_CONFIRMED"
            : !mediaFound
              ? "OUTGOING_MEDIA_NOT_CONFIRMED"
              : "DELIVERY_CONFIRMED";
        if (lastStage !== "DELIVERY_CONFIRMED") continue;
        return {
          confirmed: true,
          affiliateUrlFound,
          affiliateUrlOccurrences: text.split(input.affiliateUrl).length - 1,
          textSnippetFound,
          mediaFound,
          uploadErrorVisible: false,
          stage: "DELIVERY_CONFIRMED",
        };
      }
      await this.page.waitForTimeout(150);
    } while (Date.now() < deadline);
    return {
      confirmed: false,
      affiliateUrlFound: false,
      affiliateUrlOccurrences: 0,
      textSnippetFound: false,
      mediaFound: false,
      uploadErrorVisible: false,
      stage:
        lastStage === "OUTGOING_MESSAGE_NOT_FOUND"
          ? "DELIVERY_CONFIRMATION_TIMEOUT"
          : lastStage,
    };
  }

  async clearDraft(): Promise<WhatsAppWebDraftCleanupResult> {
    let closeTriggerFound = false;
    let escapeUsed = false;
    let discardTriggerFound = false;
    const captionOrComposer =
      (await this.findCaptionInput()) ??
      (await this.firstVisible([
        ...whatsappWebStableSelectors.composeBox.map((selector) =>
          this.page.locator(selector),
        ),
      ]));
    if (captionOrComposer) await captionOrComposer.fill("");
    const mediaSurface = await this.visibleMediaSurface();
    if (mediaSurface) {
      const close = await this.findMediaCloseTrigger();
      if (close) {
        closeTriggerFound = true;
        await close.click().catch(() => undefined);
      } else {
        escapeUsed = true;
        await this.page.keyboard.press("Escape");
      }
      discardTriggerFound =
        (await this.clickDiscardIfVisible()) || discardTriggerFound;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (!(await this.visibleMediaSurface())) break;
        escapeUsed = true;
        await this.page.keyboard.press("Escape");
        discardTriggerFound =
          (await this.clickDiscardIfVisible()) || discardTriggerFound;
        await this.page.waitForTimeout(250);
      }
    }
    const composer = await this.findWritableComposer();
    if (composer.found && composer.locator) {
      await composer.locator.fill("").catch(() => undefined);
    }
    return { closeTriggerFound, escapeUsed, discardTriggerFound };
  }

  async isDraftClear() {
    const deadline = Date.now() + Math.min(this.actionTimeoutMs, 5_000);
    do {
      if (await this.isDraftClearOnce()) return true;
      await this.page.waitForTimeout(150);
    } while (Date.now() < deadline);
    const activeMediaCaptionFound = Boolean(
      await this.findCaptionInputInMediaSurface(),
    );
    const discardTriggerVisible = Boolean(await this.findDiscardTrigger());
    const composer = await this.findWritableComposer();
    const normalComposerEmpty =
      !composer.found ||
      !composer.locator ||
      normalizedText(await composer.locator.innerText().catch(() => "")) === "";
    throw await this.stageError(
      "DRAFT_CLEANUP_FAILED",
      {},
      {
        activeMediaCaptionFound,
        discardTriggerVisible,
        normalComposerEmpty,
      },
    );
  }

  private async isDraftClearOnce() {
    if (await this.findCaptionInputInMediaSurface()) {
      return false;
    }
    if (await this.findDiscardTrigger()) return false;
    const composer = await this.findWritableComposer();
    if (!composer.found || !composer.locator) return true;
    return (
      normalizedText(await composer.locator.innerText().catch(() => "")) === ""
    );
  }

  async capturePreparedDraft(path: string) {
    const draft = this.page.locator(
      "[data-testid='media-caption-input-container'], footer",
    );
    const count = await draft.count();
    if (
      count === 0 ||
      !(await draft
        .nth(count - 1)
        .isVisible()
        .catch(() => false))
    )
      throw new Error("WHATSAPP_WEB_SELECTOR_MISMATCH");
    await draft.nth(count - 1).screenshot({ path });
  }

  private async findAuthenticatedShellOnce(): Promise<LocatedControl> {
    return this.findControl(
      whatsappWebStableSelectors.authenticatedShell.map((selector) =>
        this.page.locator(selector),
      ),
      "APP_SHELL_NOT_FOUND",
      false,
    );
  }

  private async findGlobalSearchTriggerControl(): Promise<LocatedControl> {
    const sidebar = await this.sidebar();
    const roleLocators = sidebar
      ? whatsappWebAccessibleAliases.search.map((name) =>
          sidebar.getByRole("button", { name, exact: true }),
        )
      : [];
    const result = await this.findControl(
      [
        ...roleLocators,
        ...whatsappWebStableSelectors.searchTrigger.map((selector) =>
          this.page.locator(selector),
        ),
      ],
      "SEARCH_TRIGGER_NOT_FOUND",
      false,
    );
    if (!result.found && result.matched) {
      return this.controlFailure(
        "SEARCH_TRIGGER_NOT_INTERACTABLE",
        result.strategiesTried,
        result,
        true,
      );
    }
    return result;
  }

  private async findGlobalSearchInputControl(): Promise<LocatedControl> {
    const sidebar = await this.sidebar();
    const roleLocators = sidebar
      ? whatsappWebAccessibleAliases.search.map((name) =>
          sidebar.getByRole("textbox", { name, exact: true }),
        )
      : [];
    let result = await this.findControl(
      [
        ...roleLocators,
        ...whatsappWebStableSelectors.searchInput.map((selector) =>
          this.page.locator(selector),
        ),
      ],
      "SEARCH_INPUT_NOT_FOUND",
      true,
    );
    if (!result.found && result.matched) {
      result = this.controlFailure(
        result.visible
          ? "SEARCH_INPUT_NOT_EDITABLE"
          : "SEARCH_INPUT_NOT_VISIBLE",
        result.strategiesTried,
        result,
        true,
      );
    }
    if (result.found && result.locator) this.globalSearchInput = result.locator;
    return result;
  }

  private async findWritableComposer(): Promise<LocatedControl> {
    const main = this.page.locator("#main, main");
    const roleLocators = whatsappWebAccessibleAliases.composer.map((name) =>
      main.getByRole("textbox", { name, exact: true }),
    );
    return this.findControl(
      [
        ...roleLocators,
        ...whatsappWebStableSelectors.composeBox.map((selector) =>
          this.page.locator(selector),
        ),
      ],
      "COMPOSER_NOT_FOUND",
      true,
    );
  }

  private async findExactGroupResult(name: string) {
    let strategiesTried = 0;
    let genericCandidateCount = 0;
    for (const selector of whatsappWebExactGroupResultSelectors(name)) {
      strategiesTried += 1;
      const locator = this.page.locator(selector);
      const count = await locator.count().catch(() => 0);
      if (count === 0) continue;
      const first = locator.nth(0);
      const visible = await first.isVisible().catch(() => false);
      const enabled = await first.isEnabled().catch(() => false);
      return {
        count,
        locator: first,
        visible,
        enabled,
        strategiesTried,
        candidateCount: count,
      };
    }
    genericCandidateCount = await this.countFirstAvailableStrategy(
      whatsappWebStableSelectors.genericSearchCandidate,
    );
    return {
      count: 0,
      locator: null,
      visible: false,
      enabled: false,
      strategiesTried,
      candidateCount: genericCandidateCount,
    };
  }

  private async waitForOpenedHeader(
    name: string,
  ): Promise<WhatsAppWebControlResult> {
    const deadline = Date.now() + this.actionTimeoutMs;
    let headerRecognized = false;
    do {
      for (const selector of whatsappWebStableSelectors.conversationTitle) {
        const titles = this.page.locator(selector);
        const count = await titles.count().catch(() => 0);
        if (count === 0) continue;
        headerRecognized = true;
        for (let index = 0; index < count; index += 1) {
          const candidate = titles.nth(index);
          if (!(await candidate.isVisible().catch(() => false))) continue;
          const title =
            (await candidate.getAttribute("title").catch(() => null)) ??
            (await candidate.innerText().catch(() => ""));
          if (normalizedText(title) === normalizedText(name)) {
            return {
              found: true,
              stage: "GROUP_FOUND",
              strategiesTried:
                whatsappWebStableSelectors.conversationTitle.length,
              visible: true,
              enabled: true,
            };
          }
        }
      }
      await this.page.waitForTimeout(150);
    } while (Date.now() < deadline);
    return this.controlFailure(
      headerRecognized ? "GROUP_HEADER_MISMATCH" : "GROUP_HEADER_NOT_FOUND",
      whatsappWebStableSelectors.conversationTitle.length,
    );
  }

  private async hasReadOnlySignal() {
    const footer = this.page.locator(
      whatsappWebStableSelectors.readOnlyFooter.join(","),
    );
    for (const text of whatsappWebAccessibleAliases.readOnly) {
      const signal = footer.getByText(text, { exact: false });
      if (
        (await signal.count()) > 0 &&
        (await signal
          .first()
          .isVisible()
          .catch(() => false))
      )
        return true;
    }
    return false;
  }

  private async findImageOption() {
    const menu = await this.firstVisible(
      whatsappWebStableSelectors.attachMenu.map((selector) =>
        this.page.locator(selector),
      ),
    );
    const scope = menu ?? this.page.locator("#main, main");
    return this.firstVisible([
      ...whatsappWebAccessibleAliases.photo.flatMap((name) => [
        scope.getByRole("menuitem", { name, exact: true }),
        scope.getByRole("button", { name, exact: true }),
        scope.getByText(name, { exact: true }),
      ]),
      ...whatsappWebStableSelectors.imageOption.map((selector) =>
        this.page.locator(selector),
      ),
    ]);
  }

  private async findCaptionInput() {
    const scoped = await this.findCaptionInputInMediaSurface();
    if (scoped) return scoped;
    const preview = await this.firstVisible(
      whatsappWebStableSelectors.mediaPreview.map((selector) =>
        this.page.locator(selector),
      ),
    );
    if (!preview) return null;
    const candidate = await this.firstVisible([
      ...whatsappWebAccessibleAliases.caption.map((name) =>
        this.page.getByRole("textbox", { name, exact: false }),
      ),
      ...whatsappWebStableSelectors.captionInput.map((selector) =>
        this.page.locator(selector),
      ),
    ]);
    if (!candidate) return null;
    const outsideConversationList =
      (await candidate
        .locator("xpath=ancestor::*[@id='side' or @id='pane-side']")
        .count()
        .catch(() => 0)) === 0;
    return outsideConversationList ? candidate : null;
  }

  private async findCaptionInputInMediaSurface() {
    for (const selector of whatsappWebStableSelectors.mediaSurface) {
      const surfaces = this.page.locator(selector);
      const count = await surfaces.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const surface = surfaces.nth(index);
        if (!(await surface.isVisible().catch(() => false))) continue;
        const candidate = await this.firstVisible([
          ...whatsappWebAccessibleAliases.caption.map((name) =>
            surface.getByRole("textbox", { name, exact: false }),
          ),
          surface.locator("[contenteditable='true'][role='textbox']"),
          surface.locator("[contenteditable='true']"),
        ]);
        if (candidate) return candidate;
      }
    }
    return null;
  }

  private async readEditableText(control: Locator) {
    const lexicalText = await control
      .locator("[data-lexical-text='true']")
      .allInnerTexts()
      .catch(() => []);
    return normalizedText(
      lexicalText.length > 0
        ? lexicalText.join("")
        : await control.innerText().catch(() => ""),
    );
  }

  private async hasMediaUploadInProgress() {
    for (const surface of await this.visibleMediaSurfaces()) {
      const loading = await this.firstVisible(
        whatsappWebStableSelectors.loadingOverlays.map((selector) =>
          surface.locator(selector),
        ),
      );
      if (loading) return true;
    }
    return false;
  }

  private async waitForStableMediaEditor() {
    const deadline = Date.now() + this.actionTimeoutMs;
    let stableObservations = 0;
    do {
      const preview = await this.firstVisible(
        whatsappWebStableSelectors.mediaPreview.map((selector) =>
          this.page.locator(selector),
        ),
      );
      const loading = await this.hasMediaUploadInProgress();
      const caption = await this.findCaptionInput();
      if (
        preview &&
        caption &&
        (await caption.isVisible().catch(() => false)) &&
        (await caption.isEditable().catch(() => false)) &&
        !loading
      ) {
        stableObservations += 1;
        if (stableObservations >= 2) return;
      } else {
        stableObservations = 0;
      }
      await this.page.waitForTimeout(150);
    } while (Date.now() < deadline);
    throw await this.stageError(
      "CAPTION_INPUT_NOT_FOUND",
      {},
      {
        captionInputFound: false,
        captionInputVisible: false,
        captionInputEditable: false,
        captionStable: false,
        uploadInProgressVisible: await this.hasMediaUploadInProgress(),
      },
    );
  }

  private async visibleMediaSurface() {
    return (await this.visibleMediaSurfaces())[0] ?? null;
  }

  private async visibleMediaSurfaces() {
    const visible: Locator[] = [];
    for (const selector of whatsappWebStableSelectors.mediaSurface) {
      const candidates = this.page.locator(selector);
      const count = await candidates.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const candidate = candidates.nth(index);
        if (await candidate.isVisible().catch(() => false)) {
          visible.push(candidate);
        }
      }
    }
    return visible;
  }

  private async isInsideCurrentMediaEditor(candidate: Locator) {
    const editorAncestor = candidate.locator(
      "xpath=ancestor::*[.//*[@contenteditable='true'] and (.//*[@data-testid='media-caption-input-container'] or .//*[@data-testid='media-preview'] or @role='dialog' or @aria-modal='true')][1]",
    );
    return (await editorAncestor.count().catch(() => 0)) === 1;
  }

  private async findMediaCloseTrigger() {
    const aliases = [
      ...whatsappWebAccessibleAliases.close,
      ...whatsappWebAccessibleAliases.cancel,
      ...whatsappWebAccessibleAliases.back,
    ];
    for (const surface of await this.visibleMediaSurfaces()) {
      const candidate = await this.firstVisible(
        aliases.map((name) =>
          surface.getByRole("button", { name, exact: true }),
        ),
      );
      if (candidate) return candidate;
    }
    for (const name of aliases) {
      const candidates = this.page.getByRole("button", { name, exact: true });
      const count = await candidates.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const candidate = candidates.nth(index);
        if (
          (await candidate.isVisible().catch(() => false)) &&
          (await this.isInsideCurrentMediaEditor(candidate))
        ) {
          return candidate;
        }
      }
    }
    return this.firstVisible(
      whatsappWebStableSelectors.mediaClose.map((selector) =>
        this.page.locator(selector),
      ),
    );
  }

  private async clickDiscardIfVisible() {
    const deadline = Date.now() + 2_000;
    do {
      const discard = await this.findDiscardTrigger();
      if (discard) {
        await discard.click();
        return true;
      }
      await this.page.waitForTimeout(100);
    } while (Date.now() < deadline);
    return false;
  }

  private async findDiscardTrigger() {
    return this.firstVisible(
      whatsappWebAccessibleAliases.discard.map((name) =>
        this.page.getByRole("button", { name, exact: true }),
      ),
    );
  }

  private async waitForImageFileInput(timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    do {
      for (const selector of whatsappWebStableSelectors.imageFileInput) {
        const inputs = this.page.locator(selector);
        const count = await inputs.count().catch(() => 0);
        if (count > 0) return inputs.nth(count - 1);
      }
      await this.page.waitForTimeout(100);
    } while (Date.now() < deadline);
    return null;
  }

  private async waitForMediaPreview(
    strategy: WhatsAppWebMediaAttachmentResult["attachStrategyUsed"],
    diagnostic: {
      usedFileChooser: boolean;
      usedSetInputFiles: boolean;
      previewDetected: boolean;
    },
  ): Promise<WhatsAppWebMediaAttachmentResult> {
    const deadline = Date.now() + this.actionTimeoutMs;
    let preview: Locator | null = null;
    let stableObservations = 0;
    do {
      preview = await this.firstVisible(
        whatsappWebStableSelectors.mediaPreview.map((selector) =>
          this.page.locator(selector),
        ),
      );
      if (preview && !(await this.hasMediaUploadInProgress())) {
        stableObservations += 1;
        if (stableObservations >= 2) break;
      } else {
        stableObservations = 0;
      }
      await this.page.waitForTimeout(150);
    } while (Date.now() < deadline);
    if (!preview || stableObservations < 2) {
      throw await this.stageError(
        "MEDIA_PREVIEW_NOT_FOUND",
        {},
        {
          ...diagnostic,
          attachStrategyUsed: strategy,
        },
      );
    }
    return {
      attachStrategyUsed: strategy,
      usedFileChooser: diagnostic.usedFileChooser,
      usedSetInputFiles: diagnostic.usedSetInputFiles,
      previewDetected: true,
    };
  }

  private async waitForVisible(locators: Locator[], timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    do {
      const visible = await this.firstVisible(locators);
      if (visible) return visible;
      await this.page.waitForTimeout(100);
    } while (Date.now() < deadline);
    return null;
  }

  private async sidebar() {
    return this.firstVisible(
      whatsappWebStableSelectors.sidebar.map((selector) =>
        this.page.locator(selector),
      ),
    );
  }

  private async findControl(
    locators: Locator[],
    missingStage: WhatsAppWebDiagnosticStage,
    requireEditable: boolean,
  ): Promise<LocatedControl> {
    let strategiesTried = 0;
    let sawVisible = false;
    let sawEnabled = false;
    let matched = false;
    for (const locator of locators) {
      strategiesTried += 1;
      const count = await locator.count().catch(() => 0);
      if (count === 0) continue;
      matched = true;
      for (let index = 0; index < count; index += 1) {
        const candidate = locator.nth(index);
        const visible = await candidate.isVisible().catch(() => false);
        const enabled = await candidate.isEnabled().catch(() => false);
        const editable = requireEditable
          ? await candidate.isEditable().catch(() => false)
          : undefined;
        sawVisible ||= visible;
        sawEnabled ||= enabled;
        if (visible && enabled && (!requireEditable || editable)) {
          return {
            found: true,
            stage: "READY_FOR_GROUP_SEARCH",
            strategiesTried,
            visible,
            enabled,
            ...(requireEditable && editable !== undefined ? { editable } : {}),
            locator: candidate,
            matched: true,
          };
        }
      }
    }
    return this.controlFailure(
      missingStage,
      strategiesTried,
      {
        visible: sawVisible,
        enabled: sawEnabled,
        ...(requireEditable ? { editable: false } : {}),
      },
      matched,
    );
  }

  private async firstVisible(locators: Locator[]) {
    for (const locator of locators) {
      const count = await locator.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const candidate = locator.nth(index);
        if (await candidate.isVisible().catch(() => false)) return candidate;
      }
    }
    return null;
  }

  private async anyVisible(locators: Locator[]) {
    return Boolean(await this.firstVisible(locators));
  }

  private async countFirstAvailableStrategy(selectors: readonly string[]) {
    for (const selector of selectors) {
      const count = await this.page
        .locator(selector)
        .count()
        .catch(() => 0);
      if (count > 0) return count;
    }
    return 0;
  }

  private controlFailure(
    stage: WhatsAppWebDiagnosticStage,
    strategiesTried: number,
    state: Partial<WhatsAppWebControlResult> = {},
    matched = false,
  ): LocatedControl {
    return {
      found: false,
      stage,
      strategiesTried,
      visible: state.visible ?? false,
      enabled: state.enabled ?? false,
      ...(state.editable !== undefined ? { editable: state.editable } : {}),
      matched,
    };
  }

  private locationSelectorFailure(
    control: WhatsAppWebControlResult,
    startedAt: number,
  ): WhatsAppGroupLocationResult {
    const diagnostics: WhatsAppWebSafeDiagnostics = {
      currentOrigin: "https://web.whatsapp.com",
      shellRecognized:
        control.stage !== "APP_SHELL_NOT_FOUND" &&
        control.stage !== "AUTHENTICATED_SHELL_NOT_RECOGNIZED",
      strategiesTried: control.strategiesTried,
      visible: control.visible,
      enabled: control.enabled,
      ...(control.editable !== undefined ? { editable: control.editable } : {}),
      durationMs: Date.now() - startedAt,
      errorCode: "WHATSAPP_WEB_SELECTOR_MISMATCH",
      rootCause: control.stage,
    };
    return {
      status: "SELECTOR_MISMATCH",
      exactMatch: false,
      publishPermission: false,
      errorCode: "WHATSAPP_WEB_SELECTOR_MISMATCH",
      stage: control.stage,
      rootCause: control.stage,
      diagnostics,
    };
  }

  private async safeDiagnostics(
    input: Omit<
      WhatsAppWebSafeDiagnostics,
      "currentOrigin" | "interfaceLanguage"
    >,
  ): Promise<WhatsAppWebSafeDiagnostics> {
    const language = await this.page
      .locator("html")
      .getAttribute("lang")
      .catch(() => null);
    const interfaceLanguage = language?.toLowerCase().startsWith("pt")
      ? "pt"
      : language?.toLowerCase().startsWith("es")
        ? "es"
        : language?.toLowerCase().startsWith("en")
          ? "en"
          : "unknown";
    return {
      currentOrigin: "https://web.whatsapp.com",
      interfaceLanguage,
      ...input,
    };
  }

  private async stageError(
    stage: WhatsAppWebDiagnosticStage,
    state: Partial<WhatsAppWebControlResult> = {},
    diagnostic: Partial<WhatsAppWebSafeDiagnostics> = {},
    code: WhatsAppWebErrorCode = errorCodeForDiagnosticStage(stage),
  ) {
    return new WhatsAppWebStageError(
      stage,
      await this.safeDiagnostics({
        ...(this.lastLocationDiagnostics ?? {}),
        visible: state.visible ?? false,
        enabled: state.enabled ?? false,
        ...(state.editable !== undefined ? { editable: state.editable } : {}),
        ...diagnostic,
        errorCode: code,
        rootCause: stage,
      }),
      code,
    );
  }

  private async diagnosticReady(
    authentication: AuthenticationState,
    shellRecognized: boolean,
    searchTriggerFound: boolean,
    control: WhatsAppWebControlResult,
    startedAt: number,
  ): Promise<WhatsAppWebStructureDiagnosticResult> {
    return {
      authentication,
      shellRecognized,
      searchTriggerFound,
      searchInputFound: true,
      stage: "READY_FOR_GROUP_SEARCH",
      diagnostics: await this.safeDiagnostics({
        shellRecognized,
        strategiesTried: control.strategiesTried,
        visible: control.visible,
        enabled: control.enabled,
        ...(control.editable !== undefined
          ? { editable: control.editable }
          : {}),
        durationMs: Date.now() - startedAt,
      }),
    };
  }

  private async diagnosticFailure(
    authentication: AuthenticationState,
    control: WhatsAppWebControlResult,
    startedAt: number,
    searchTriggerFound = false,
  ): Promise<WhatsAppWebStructureDiagnosticResult> {
    return {
      authentication,
      shellRecognized:
        control.stage !== "APP_SHELL_NOT_FOUND" &&
        control.stage !== "AUTHENTICATED_SHELL_NOT_RECOGNIZED",
      searchTriggerFound,
      searchInputFound: false,
      stage: control.stage,
      diagnostics: await this.safeDiagnostics({
        strategiesTried: control.strategiesTried,
        visible: control.visible,
        enabled: control.enabled,
        ...(control.editable !== undefined
          ? { editable: control.editable }
          : {}),
        durationMs: Date.now() - startedAt,
        errorCode: "WHATSAPP_WEB_SELECTOR_MISMATCH",
        rootCause: control.stage,
      }),
    };
  }
}
