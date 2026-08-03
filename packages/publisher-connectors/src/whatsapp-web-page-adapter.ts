import type { ElementHandle, Locator, Page } from "playwright";
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
  type WhatsAppWebMediaLayoutInspection,
  type WhatsAppWebPageAdapter,
  type WhatsAppWebSafeDiagnostics,
  type WhatsAppWebSendTriggerInspection,
  type WhatsAppWebStructureDiagnosticResult,
} from "./whatsapp-web-types";
import { selectWhatsAppMediaCaptionCandidate } from "./whatsapp-web-layout";

function normalizedText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function normalizedEditableText(value: string) {
  return value.replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ");
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
  if (stage.startsWith("CAPTION_") || stage === "DRAFT_VALIDATION_FAILED") {
    return "WHATSAPP_WEB_DRAFT_VALIDATION_FAILED";
  }
  return "WHATSAPP_WEB_SELECTOR_MISMATCH";
}

type LocatedControl = WhatsAppWebControlResult & {
  locator?: Locator;
  matched?: boolean;
};

type VisualCaptionTarget = {
  locator: Locator;
  overlay: Locator;
  diagnostics: WhatsAppWebSafeDiagnostics;
};

export class PlaywrightWhatsAppWebPageAdapter implements WhatsAppWebPageAdapter {
  private globalSearchInput: Locator | null = null;
  private exactGroupResult: Locator | null = null;
  private lastLocationDiagnostics: WhatsAppWebSafeDiagnostics | null = null;
  private validatedSendTrigger: Locator | null = null;
  private validatedSendMediaExpected = false;
  private activeMediaSendTrigger: Locator | null = null;
  private mediaEditorBaseline: Array<{
    identity: string;
    surfaceFingerprint: string;
  }> = [];
  private mediaPreviewBaseline: string[] = [];
  private mediaEditorBaselineCaptured = false;

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

  async captureMediaEditorBaseline() {
    const baseline = await this.page.evaluate(() => {
      globalThis.eval("globalThis.__name=(target)=>target");
      const hash = (value: string) => {
        let result = 5381;
        for (let index = 0; index < value.length; index += 1) {
          result = (result * 33) ^ value.charCodeAt(index);
        }
        return (result >>> 0).toString(16).padStart(8, "0");
      };
      const stackingSurface = (element: Element) => {
        let current: Element | null = element;
        while (current && current !== document.documentElement) {
          const style = getComputedStyle(current);
          if (
            current.getAttribute("role") === "dialog" ||
            current.getAttribute("aria-modal") === "true" ||
            style.position === "fixed" ||
            (style.position !== "static" && style.zIndex !== "auto") ||
            style.transform !== "none"
          ) {
            return current;
          }
          current = current.parentElement;
        }
        return document.body;
      };
      const structural = (element: Element) => {
        const dataNames = Array.from(element.attributes)
          .map((attribute) => attribute.name)
          .filter((name) => name.startsWith("data-"))
          .sort();
        const label =
          element.getAttribute("aria-label") ??
          element.getAttribute("aria-placeholder") ??
          "";
        const surface = stackingSurface(element);
        const identity = [
          element.tagName.toLowerCase(),
          element.getAttribute("role") ?? "",
          element.getAttribute("contenteditable") ?? "",
          hash(String(element.getAttribute("class") ?? "")),
          hash(label),
          dataNames.join(","),
        ].join("|");
        return {
          identity,
          surfaceFingerprint: [
            surface.tagName.toLowerCase(),
            surface.getAttribute("role") ?? "",
            hash(String(surface.getAttribute("class") ?? "")),
          ].join("|"),
        };
      };
      const editables = Array.from(
        document.querySelectorAll("[contenteditable='true']"),
      )
        .filter((element) => {
          const box = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return (
            box.width > 0 &&
            box.height > 0 &&
            style.display !== "none" &&
            style.visibility !== "hidden"
          );
        })
        .map(structural);
      const previewFingerprint = (element: Element) => {
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return [
          element.tagName.toLowerCase(),
          hash(String(element.getAttribute("class") ?? "")),
          hash(style.backgroundImage),
          Math.round(box.x / 10),
          Math.round(box.y / 10),
          Math.round(box.width / 10),
          Math.round(box.height / 10),
        ].join("|");
      };
      const previewElements = Array.from(
        document.querySelectorAll("img, canvas, video, [role='img'], div"),
      ).filter((element) => {
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const mediaElement =
          /^(img|canvas|video)$/i.test(element.tagName) ||
          element.getAttribute("role") === "img" ||
          style.backgroundImage !== "none";
        return (
          mediaElement &&
          box.width * box.height >= 10_000 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number(style.opacity || "1") > 0
        );
      });
      return {
        editables,
        previewFingerprints: previewElements.map(previewFingerprint),
      };
    });
    this.mediaEditorBaseline = baseline.editables;
    this.mediaPreviewBaseline = baseline.previewFingerprints;
    this.mediaEditorBaselineCaptured = true;
  }

  async inspectMediaLayout(): Promise<WhatsAppWebMediaLayoutInspection> {
    const raw = await this.page.evaluate(
      ({ previewSelectors, baseline, previewBaseline }) => {
        globalThis.eval("globalThis.__name=(target)=>target");
        const hash = (value: string) => {
          let result = 5381;
          for (let index = 0; index < value.length; index += 1) {
            result = (result * 33) ^ value.charCodeAt(index);
          }
          return (result >>> 0).toString(16).padStart(8, "0");
        };
        const visible = (element: Element) => {
          const box = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return (
            element.isConnected &&
            box.width > 0 &&
            box.height > 0 &&
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            Number(style.opacity || "1") > 0
          );
        };
        const unique = <T extends Element>(elements: T[]) =>
          Array.from(new Set(elements));
        const queryAll = (selectors: readonly string[]) =>
          unique(
            selectors.flatMap((selector) => {
              try {
                return Array.from(document.querySelectorAll(selector));
              } catch {
                return [];
              }
            }),
          );
        const buttonLabel = (element: Element) =>
          [
            element.getAttribute("aria-label"),
            element.getAttribute("title"),
            element.getAttribute("data-testid"),
            element.querySelector("[data-icon]")?.getAttribute("data-icon"),
            element.querySelector("[data-testid]")?.getAttribute("data-testid"),
          ]
            .filter(Boolean)
            .join(" ")
            .toLocaleLowerCase();
        const buttonElements = Array.from(
          document.querySelectorAll("button, [role='button']"),
        );
        const buttons = buttonElements.filter(visible);
        const previewFingerprint = (element: Element) => {
          const box = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return [
            element.tagName.toLowerCase(),
            hash(String(element.getAttribute("class") ?? "")),
            hash(style.backgroundImage),
            Math.round(box.x / 10),
            Math.round(box.y / 10),
            Math.round(box.width / 10),
            Math.round(box.height / 10),
          ].join("|");
        };
        const createdVisualMedia = Array.from(
          document.querySelectorAll("img, canvas, video, [role='img'], div"),
        ).filter((element) => {
          const box = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          const mediaElement =
            /^(img|canvas|video)$/i.test(element.tagName) ||
            element.getAttribute("role") === "img" ||
            style.backgroundImage !== "none";
          return (
            mediaElement &&
            visible(element) &&
            box.width * box.height >= 10_000 &&
            !previewBaseline.includes(previewFingerprint(element))
          );
        });
        const previews = unique([
          ...queryAll(previewSelectors).filter(visible),
          ...createdVisualMedia,
        ]);
        const preview = previews.sort((left, right) => {
          const a = left.getBoundingClientRect();
          const b = right.getBoundingClientRect();
          return b.width * b.height - a.width * a.height;
        })[0];
        const sends = buttons.filter((element) =>
          /(^|\s)(send|enviar)(\s|$)/i.test(buttonLabel(element)),
        );
        const closes = buttons.filter((element) =>
          /(^|\s)(close|fechar|cerrar|back|voltar|cancel|cancelar|x-viewer)(\s|$)/i.test(
            buttonLabel(element),
          ),
        );
        const distance = (element: Element, anchor?: Element) => {
          if (!anchor) return Number.MAX_SAFE_INTEGER;
          const left = element.getBoundingClientRect();
          const right = anchor.getBoundingClientRect();
          return Math.hypot(
            left.left + left.width / 2 - (right.left + right.width / 2),
            left.top + left.height / 2 - (right.top + right.height / 2),
          );
        };
        const stackingSurface = (element?: Element) => {
          let current: Element | null = element ?? null;
          while (current && current !== document.documentElement) {
            const style = getComputedStyle(current);
            if (
              current.getAttribute("role") === "dialog" ||
              current.getAttribute("aria-modal") === "true" ||
              style.position === "fixed" ||
              (style.position !== "static" && style.zIndex !== "auto") ||
              style.transform !== "none"
            ) {
              return current;
            }
            current = current.parentElement;
          }
          return document.body;
        };
        const topLevelSurface = (element?: Element) => {
          let current: Element | null = element ?? null;
          let result: Element = document.body;
          while (current && current !== document.documentElement) {
            const style = getComputedStyle(current);
            if (
              current.getAttribute("role") === "dialog" ||
              current.getAttribute("aria-modal") === "true" ||
              style.position === "fixed"
            ) {
              result = current;
            }
            current = current.parentElement;
          }
          return result;
        };
        const topmost = (element: Element) => {
          const box = element.getBoundingClientRect();
          const x = box.left + box.width / 2;
          const y = box.top + box.height / 2;
          const stack = document.elementsFromPoint(x, y);
          const hit = stack[0];
          return Boolean(hit && (hit === element || element.contains(hit)));
        };
        const relatedToPreview = (element: Element) =>
          Boolean(
            preview &&
            topmost(element) &&
            (topLevelSurface(element) === topLevelSurface(preview) ||
              stackingSurface(element) === stackingSurface(preview)),
          );
        const relatedSends = sends.filter(relatedToPreview);
        const relatedCloses = closes.filter(relatedToPreview);
        const send =
          relatedSends.length === 1
            ? relatedSends.sort(
                (left, right) =>
                  distance(left, preview) - distance(right, preview),
              )[0]
            : undefined;
        const close =
          relatedCloses.length === 1
            ? relatedCloses.sort(
                (left, right) =>
                  distance(left, preview) - distance(right, preview),
              )[0]
            : undefined;
        const ancestorDepth = (left?: Element, right?: Element) => {
          if (!left || !right) return null;
          const ancestors = new Map<Element, number>();
          let current: Element | null = left;
          let depth = 0;
          while (current) {
            ancestors.set(current, depth++);
            current = current.parentElement;
          }
          current = right;
          depth = 0;
          while (current) {
            const leftDepth = ancestors.get(current);
            if (leftDepth !== undefined) return leftDepth + depth;
            current = current.parentElement;
            depth += 1;
          }
          return null;
        };
        const structural = (element: Element) => {
          const dataNames = Array.from(element.attributes)
            .map((attribute) => attribute.name)
            .filter((name) => name.startsWith("data-"))
            .sort();
          const label =
            element.getAttribute("aria-label") ??
            element.getAttribute("aria-placeholder") ??
            "";
          const surface = stackingSurface(element);
          return {
            identity: [
              element.tagName.toLowerCase(),
              element.getAttribute("role") ?? "",
              element.getAttribute("contenteditable") ?? "",
              hash(String(element.getAttribute("class") ?? "")),
              hash(label),
              dataNames.join(","),
            ].join("|"),
            surfaceFingerprint: [
              surface.tagName.toLowerCase(),
              surface.getAttribute("role") ?? "",
              hash(String(surface.getAttribute("class") ?? "")),
            ].join("|"),
            classNameHash: hash(String(element.getAttribute("class") ?? "")),
            dataNames,
            label,
          };
        };
        const editables = Array.from(
          document.querySelectorAll("[contenteditable='true']"),
        );
        const surfaceSet = new Set<Element>();
        [preview, send, close].filter(Boolean).forEach((anchor) => {
          surfaceSet.add(stackingSurface(anchor));
          surfaceSet.add(topLevelSurface(anchor));
        });
        const candidates = editables.map((element, candidateIndex) => {
          const box = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          const structure = structural(element);
          const existedBefore = baseline.some(
            (entry) => entry.identity === structure.identity,
          );
          const changedSurface =
            existedBefore &&
            !baseline.some(
              (entry) =>
                entry.identity === structure.identity &&
                entry.surfaceFingerprint === structure.surfaceFingerprint,
            );
          const centerX = box.left + box.width / 2;
          const centerY = box.top + box.height / 2;
          const insideViewport =
            centerX >= 0 &&
            centerY >= 0 &&
            centerX < window.innerWidth &&
            centerY < window.innerHeight;
          const hit = insideViewport
            ? document.elementsFromPoint(centerX, centerY)[0]
            : null;
          const topmost = Boolean(
            hit && (hit === element || element.contains(hit)),
          );
          const previewBox = preview?.getBoundingClientRect();
          const overlapsPreview = Boolean(
            previewBox &&
            box.left < previewBox.right &&
            box.right > previewBox.left &&
            box.top < previewBox.bottom &&
            box.bottom > previewBox.top,
          );
          const horizontallyAligned = Boolean(
            previewBox &&
            box.left < previewBox.right &&
            box.right > previewBox.left,
          );
          const verticalGap = previewBox
            ? Math.min(
                Math.abs(box.top - previewBox.bottom),
                Math.abs(previewBox.top - box.bottom),
              )
            : Number.MAX_SAFE_INTEGER;
          const semantic = Boolean(
            /caption|legenda|comentario/i.test(structure.label) ||
            element.closest("[data-testid='media-caption-input-container']"),
          );
          const sameTopLevelPreview = Boolean(
            preview && topLevelSurface(element) === topLevelSurface(preview),
          );
          const sameStackingPreview = Boolean(
            preview && stackingSurface(element) === stackingSurface(preview),
          );
          const sameStackingSend = Boolean(
            send && stackingSurface(element) === stackingSurface(send),
          );
          const sameTopLevelSend = Boolean(
            send && topLevelSurface(element) === topLevelSurface(send),
          );
          const isVisible = visible(element);
          const editable =
            element.getAttribute("contenteditable") === "true" &&
            !element.hasAttribute("disabled");
          const ariaHidden = Boolean(element.closest("[aria-hidden='true']"));
          const active = Boolean(
            document.activeElement === element ||
            (document.activeElement &&
              element.contains(document.activeElement)),
          );
          return {
            candidateIndex,
            evidence: {
              index: candidateIndex,
              existedBeforePreview: existedBefore,
              changedSurfaceAfterPreview: changedSurface,
              semanticCaption: semantic,
              visible: isVisible,
              editable,
              attached: element.isConnected,
              ariaHidden,
              insideViewport,
              topmostAtCenter: topmost,
              sameTopLevelSurfaceAsPreview: sameTopLevelPreview,
              sameStackingContextAsPreview: sameStackingPreview,
              sameStackingContextAsSend: sameStackingSend,
              sameTopLevelSurfaceAsSend: sameTopLevelSend,
              overlapsPreview,
              verticallyAdjacentToPreview: verticalGap <= 240,
              horizontallyAlignedWithPreview: horizontallyAligned,
            },
            diagnostic: {
              candidateIndex,
              tagName: element.tagName.toLowerCase(),
              role: element.getAttribute("role"),
              contentEditable: element.getAttribute("contenteditable"),
              ariaHidden,
              disabled: element.hasAttribute("disabled"),
              attached: element.isConnected,
              visible: isVisible,
              editable,
              boundingBox:
                box.width > 0 && box.height > 0
                  ? {
                      x: box.x,
                      y: box.y,
                      width: box.width,
                      height: box.height,
                    }
                  : null,
              computedStyle: {
                display: style.display,
                visibility: style.visibility,
                opacity: style.opacity,
                position: style.position,
                zIndex: style.zIndex,
                pointerEvents: style.pointerEvents,
              },
              relationships: {
                containsPreview: Boolean(preview && element.contains(preview)),
                containsSendTrigger: Boolean(send && element.contains(send)),
                containsCloseTrigger: Boolean(close && element.contains(close)),
                containsCaptionCandidate: true,
                commonAncestorDepthWithPreview: ancestorDepth(element, preview),
                commonAncestorDepthWithSend: ancestorDepth(element, send),
                sameTopLevelSurfaceAsPreview: sameTopLevelPreview,
                sameStackingContextAsPreview: sameStackingPreview,
                sameStackingContextAsSend: sameStackingSend,
                overlapsPreview,
                verticallyAdjacentToPreview: verticalGap <= 240,
                horizontallyAlignedWithPreview: horizontallyAligned,
                insideViewport,
                topmostAtCenter: topmost,
                activeElementOrContainsActiveElement: active,
              },
              classNameHash: structure.classNameHash,
              dataAttributeNames: structure.dataNames,
              captionCandidateExistedBeforePreview: existedBefore,
              captionCandidateCreatedAfterPreview: !existedBefore,
              captionCandidateChangedSurfaceAfterPreview: changedSurface,
            },
          };
        });
        return {
          previewFound: Boolean(preview),
          sendTriggerFound: Boolean(send),
          sendTriggerCandidateCount: relatedSends.length,
          sendTriggerDomIndex: send ? buttonElements.indexOf(send) : null,
          closeTriggerFound: Boolean(close),
          surfaceCandidateCount: surfaceSet.size,
          candidates,
        };
      },
      {
        previewSelectors: whatsappWebStableSelectors.mediaPreview.filter(
          (selector) => !selector.includes("media-caption-input-container"),
        ),
        baseline: this.mediaEditorBaseline,
        previewBaseline: this.mediaPreviewBaseline,
      },
    );
    const selection = selectWhatsAppMediaCaptionCandidate(
      raw.candidates.map((candidate) => candidate.evidence),
    );
    this.activeMediaSendTrigger =
      raw.sendTriggerDomIndex === null
        ? null
        : this.page
            .locator("button, [role='button']")
            .nth(raw.sendTriggerDomIndex);
    return {
      status: selection.status,
      previewFound: raw.previewFound,
      sendTriggerFound: raw.sendTriggerFound,
      sendTriggerCandidateCount: raw.sendTriggerCandidateCount,
      closeTriggerFound: raw.closeTriggerFound,
      surfaceCandidateCount: raw.surfaceCandidateCount,
      captionCandidateCount: raw.candidates.length,
      selectedCaptionCandidateIndex: selection.selectedIndex,
      candidateDecisions: selection.decisions,
      captionCandidates: raw.candidates.map(
        (candidate) => candidate.diagnostic,
      ),
      sendCalled: false,
    };
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
    const expected = normalizedEditableText(input.text);
    let lastError: WhatsAppWebStageError | null = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      let originalElement: ElementHandle<HTMLElement | SVGElement> | null =
        null;
      try {
        const target = await this.resolveVisibleCaptionTarget();
        originalElement = await target.locator.elementHandle();
        const attachedBeforeFill = originalElement
          ? await originalElement
              .evaluate((element) => element.isConnected)
              .catch(() => false)
          : false;
        await target.locator.click();
        await target.locator.focus();
        const focused = await this.isActiveEditable(target.locator);
        if (!focused) {
          throw await this.stageError(
            "CAPTION_FOCUS_NOT_CONFIRMED",
            {},
            {
              ...target.diagnostics,
              captionFillAttempts: attempt,
              captionAttachedBeforeFill: attachedBeforeFill,
              captionActiveElementConfirmed: false,
            },
          );
        }
        await this.page.keyboard.press("Control+A");
        await this.page.keyboard.press("Backspace");
        await this.page.keyboard.insertText(input.text);
        await this.page.waitForTimeout(250);
        const attachedAfterFill = originalElement
          ? await originalElement
              .evaluate((element) => element.isConnected)
              .catch(() => false)
          : false;
        if (!attachedAfterFill) {
          throw await this.stageError(
            "CAPTION_INPUT_RECREATED",
            {},
            {
              ...target.diagnostics,
              captionFillAttempts: attempt,
              captionAttachedBeforeFill: attachedBeforeFill,
              captionAttachedAfterFill: false,
              captionReResolvedAfterFill: true,
            },
          );
        }
        const observationOne = await this.observeVisibleCaption({
          expected,
          affiliateUrl: input.affiliateUrl,
          textSnippet: input.textSnippet,
          requireActive: true,
        });
        await this.page.waitForTimeout(300);
        const observationTwo = await this.observeVisibleCaption({
          expected,
          affiliateUrl: input.affiliateUrl,
          textSnippet: input.textSnippet,
          requireActive: true,
        });
        if (
          !observationOne.exact ||
          !observationTwo.exact ||
          observationOne.textLength !== observationTwo.textLength ||
          observationTwo.affiliateUrlOccurrenceCount !== 1 ||
          !observationTwo.titleSnippetConfirmed
        ) {
          const stage: WhatsAppWebDiagnosticStage =
            observationTwo.textLength === 0
              ? "CAPTION_VISIBLE_TEXT_MISSING"
              : "CAPTION_VISIBLE_TEXT_MISMATCH";
          throw await this.stageError(
            stage,
            {},
            {
              ...observationTwo.target.diagnostics,
              captionFillAttempts: attempt,
              captionAttachedBeforeFill: attachedBeforeFill,
              captionAttachedAfterFill: attachedAfterFill,
              captionReResolvedAfterFill: true,
              captionStable: false,
              captionLengthExpected: expected.length,
              captionLengthObserved: observationTwo.textLength,
            },
          );
        }
        return {
          ...observationTwo.target.diagnostics,
          captionDetected: true as const,
          captionInputFound: true as const,
          captionInputVisible: true as const,
          captionInputEditable: true as const,
          captionFillAttempts: attempt,
          captionStable: true as const,
          captionLengthExpected: expected.length,
          captionLengthObserved: observationTwo.textLength,
          affiliateUrlOccurrenceCount:
            observationTwo.affiliateUrlOccurrenceCount,
          titleSnippetConfirmed: true as const,
          captionVisibleTextConfirmed: true as const,
          captionOverlayScoped: true as const,
          captionTopmostConfirmed: true as const,
          captionActiveElementConfirmed: true as const,
          captionExactSnapshotConfirmed: true as const,
          captionAttachedBeforeFill: attachedBeforeFill,
          captionAttachedAfterFill: attachedAfterFill,
          captionReResolvedAfterFill: true,
          captionVisibleTextLength: observationTwo.textLength,
        };
      } catch (error) {
        lastError =
          error instanceof WhatsAppWebStageError
            ? error
            : await this.stageError("CAPTION_VISUAL_TARGET_NOT_CONFIRMED", {});
        if (attempt < 2) await this.page.waitForTimeout(200);
      } finally {
        await originalElement?.dispose().catch(() => undefined);
      }
    }
    throw (
      lastError ??
      (await this.stageError("CAPTION_VISUAL_TARGET_NOT_CONFIRMED", {}))
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
    const expectedText = normalizedEditableText(input.expectedText);
    let text = "";
    let visualDiagnostics: WhatsAppWebSafeDiagnostics = {
      currentOrigin: "https://web.whatsapp.com",
      captionVisibleTextConfirmed: !input.mediaExpected,
      captionOverlayScoped: !input.mediaExpected,
      captionTopmostConfirmed: !input.mediaExpected,
      captionActiveElementConfirmed: !input.mediaExpected,
      captionExactSnapshotConfirmed: false,
    };
    if (input.mediaExpected) {
      const first = await this.observeVisibleCaption({
        expected: expectedText,
        affiliateUrl: input.affiliateUrl,
        textSnippet: input.textSnippet,
        requireActive: true,
      });
      await this.page.waitForTimeout(300);
      const second = await this.observeVisibleCaption({
        expected: expectedText,
        affiliateUrl: input.affiliateUrl,
        textSnippet: input.textSnippet,
        requireActive: true,
      });
      if (!first.exact || !second.exact) {
        const stage: WhatsAppWebDiagnosticStage =
          second.textLength === 0
            ? "CAPTION_VISIBLE_TEXT_MISSING"
            : "CAPTION_VISIBLE_TEXT_MISMATCH";
        throw await this.stageError(
          stage,
          {},
          {
            ...second.target.diagnostics,
            captionVisibleTextLength: second.textLength,
            captionVisibleTextConfirmed: false,
            captionExactSnapshotConfirmed: false,
            captionLengthExpected: expectedText.length,
            captionLengthObserved: second.textLength,
          },
        );
      }
      text = second.text;
      visualDiagnostics = {
        ...second.target.diagnostics,
        captionVisibleTextConfirmed: first.exact && second.exact,
        captionOverlayScoped: true,
        captionTopmostConfirmed: true,
        captionActiveElementConfirmed: true,
        captionExactSnapshotConfirmed: first.exact && second.exact,
        captionVisibleTextLength: second.textLength,
      };
    } else {
      const composer = (await this.findWritableComposer()).locator;
      text = composer ? await this.readEditableText(composer) : "";
      visualDiagnostics.captionExactSnapshotConfirmed = text === expectedText;
    }
    const mediaFound = Boolean(
      await this.firstVisible(
        whatsappWebStableSelectors.mediaPreview.map((selector) =>
          this.page.locator(selector),
        ),
      ),
    );
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
      captionVisibleTextConfirmed:
        visualDiagnostics.captionVisibleTextConfirmed === true,
      captionOverlayScoped: visualDiagnostics.captionOverlayScoped === true,
      captionTopmostConfirmed:
        visualDiagnostics.captionTopmostConfirmed === true,
      captionActiveElementConfirmed:
        visualDiagnostics.captionActiveElementConfirmed === true,
      captionExactSnapshotConfirmed:
        visualDiagnostics.captionExactSnapshotConfirmed === true,
      diagnostics: visualDiagnostics,
    };
  }

  async inspectSendTrigger(input: {
    mediaExpected: boolean;
  }): Promise<WhatsAppWebSendTriggerInspection> {
    this.validatedSendTrigger = null;
    const outgoingCount = await this.page
      .locator(whatsappWebStableSelectors.outgoingMessage)
      .count()
      .catch(() => 0);
    let mediaLayout: WhatsAppWebMediaLayoutInspection | null = null;
    if (input.mediaExpected && this.mediaEditorBaselineCaptured) {
      mediaLayout = await this.inspectMediaLayout();
      if (
        mediaLayout.sendTriggerCandidateCount !== 1 ||
        !this.activeMediaSendTrigger
      ) {
        return {
          found: mediaLayout.sendTriggerCandidateCount > 0,
          visible: false,
          enabled: false,
          candidateCount: mediaLayout.sendTriggerCandidateCount,
          strategiesTried: 1,
          outgoingCount,
          boundingBoxPresent: false,
          topmostConfirmed: false,
          trialClickSucceeded: false,
          stage:
            mediaLayout.sendTriggerCandidateCount > 1
              ? "SEND_TRIGGER_AMBIGUOUS"
              : "SEND_TRIGGER_NOT_FOUND",
        };
      }
    }
    const scope = input.mediaExpected
      ? mediaLayout
        ? this.page.locator("body")
        : await this.findActiveMediaOverlay()
      : await this.firstVisible([
          this.page.locator("#main footer"),
          this.page.locator("main footer"),
        ]);
    if (!scope) {
      return {
        found: false,
        visible: false,
        enabled: false,
        candidateCount: 0,
        strategiesTried: 0,
        outgoingCount,
        boundingBoxPresent: false,
        topmostConfirmed: false,
        trialClickSucceeded: false,
        stage: "SEND_TRIGGER_NOT_FOUND",
      };
    }
    let strategiesTried = 0;
    const strategies = this.activeMediaSendTrigger
      ? [this.activeMediaSendTrigger]
      : [
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
          boundingBoxPresent: false,
          topmostConfirmed: false,
          trialClickSucceeded: false,
          stage: "SEND_TRIGGER_AMBIGUOUS",
        };
      }
      const candidate = strategy.first();
      const visual = await this.inspectActionableElement(candidate, scope);
      if (!visual.attached) {
        return {
          found: true,
          visible: visual.visible,
          enabled: visual.enabled,
          candidateCount: 1,
          strategiesTried,
          outgoingCount,
          boundingBoxPresent: visual.boundingBoxPresent,
          topmostConfirmed: visual.topmost,
          trialClickSucceeded: false,
          stage: "SEND_TRIGGER_STALE",
        };
      }
      if (!visual.visible || !visual.enabled || !visual.boundingBoxPresent) {
        return {
          found: true,
          visible: visual.visible,
          enabled: visual.enabled,
          candidateCount: 1,
          strategiesTried,
          outgoingCount,
          boundingBoxPresent: visual.boundingBoxPresent,
          topmostConfirmed: visual.topmost,
          trialClickSucceeded: false,
          stage: !visual.visible
            ? "SEND_TRIGGER_NOT_VISIBLE"
            : !visual.enabled
              ? "SEND_TRIGGER_DISABLED"
              : "SEND_TRIGGER_NOT_INTERACTABLE",
        };
      }
      if (!visual.topmost) {
        return {
          found: true,
          visible: true,
          enabled: true,
          candidateCount: 1,
          strategiesTried,
          outgoingCount,
          boundingBoxPresent: true,
          topmostConfirmed: false,
          trialClickSucceeded: false,
          stage: "SEND_TRIGGER_NOT_TOPMOST",
        };
      }
      try {
        await candidate.click({ trial: true });
      } catch (error) {
        const intercepted = /intercept|receives pointer events/i.test(
          error instanceof Error ? error.message : "",
        );
        return {
          found: true,
          visible: true,
          enabled: true,
          candidateCount: 1,
          strategiesTried,
          outgoingCount,
          boundingBoxPresent: true,
          topmostConfirmed: true,
          trialClickSucceeded: false,
          stage: intercepted
            ? "SEND_TRIGGER_INTERCEPTED"
            : "SEND_TRIGGER_TRIAL_FAILED",
        };
      }
      this.validatedSendTrigger = candidate;
      this.validatedSendMediaExpected = input.mediaExpected;
      return {
        found: true,
        visible: true,
        enabled: true,
        candidateCount: 1,
        strategiesTried,
        outgoingCount,
        boundingBoxPresent: true,
        topmostConfirmed: true,
        trialClickSucceeded: true,
        stage: "READY_TO_COMMIT_SEND",
      };
    }
    return {
      found: false,
      visible: false,
      enabled: false,
      candidateCount: 0,
      strategiesTried,
      outgoingCount,
      boundingBoxPresent: false,
      topmostConfirmed: false,
      trialClickSucceeded: false,
      stage: "SEND_TRIGGER_NOT_FOUND",
    };
  }

  async clickSendTrigger() {
    if (!this.validatedSendTrigger) {
      throw await this.stageError("SEND_TRIGGER_NOT_INTERACTABLE", {});
    }
    const refreshed = await this.inspectSendTrigger({
      mediaExpected: this.validatedSendMediaExpected,
    });
    const button = this.validatedSendTrigger;
    if (
      !button ||
      !refreshed.trialClickSucceeded ||
      !refreshed.topmostConfirmed
    ) {
      throw await this.stageError(
        refreshed.stage,
        {},
        {
          candidateCount: refreshed.candidateCount,
          visible: refreshed.visible,
          enabled: refreshed.enabled,
          sendTriggerBoundingBoxPresent: refreshed.boundingBoxPresent,
          sendTriggerTopmostConfirmed: refreshed.topmostConfirmed,
          sendTriggerTrialSucceeded: refreshed.trialClickSucceeded,
        },
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

  async holdDraftOpen(ms: number) {
    await this.page.waitForTimeout(ms);
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
    await this.clearNormalComposer();
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
    const composer = await this.findNormalComposer();
    const normalComposerEmpty =
      !composer.found ||
      !composer.locator ||
      normalizedEditableText(
        await composer.locator.innerText().catch(() => ""),
      ).trim() === "";
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
    const composer = await this.findNormalComposer();
    if (!composer.found || !composer.locator) return true;
    return (
      normalizedEditableText(
        await composer.locator.innerText().catch(() => ""),
      ).trim() === ""
    );
  }

  private async clearNormalComposer() {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const composer = await this.findNormalComposer();
      if (!composer.found || !composer.locator) return;
      const current = normalizedEditableText(
        await composer.locator.innerText().catch(() => ""),
      ).trim();
      if (current === "") return;
      await composer.locator.fill("").catch(() => undefined);
      const afterFill = normalizedEditableText(
        await composer.locator.innerText().catch(() => ""),
      ).trim();
      if (afterFill === "") return;
      const actionable = await this.inspectActionableElement(
        composer.locator,
        this.page.locator("#main, main"),
      );
      if (actionable.topmost) {
        await composer.locator.click().catch(() => undefined);
        await this.page.keyboard.press("Control+A").catch(() => undefined);
        await this.page.keyboard.press("Backspace").catch(() => undefined);
      }
      await this.page.waitForTimeout(150);
    }
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

  private async findNormalComposer(): Promise<LocatedControl> {
    return this.findControl(
      whatsappWebStableSelectors.composeBox.map((selector) =>
        this.page.locator(selector),
      ),
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
    return this.resolveVisibleCaptionTarget()
      .then((target) => target.locator)
      .catch(() => null);
  }

  private async findCaptionInputInMediaSurface() {
    return this.findCaptionInput();
  }

  private async readEditableText(control: Locator) {
    return normalizedEditableText(await control.innerText().catch(() => ""));
  }

  private async findActiveMediaOverlay() {
    const controls =
      "(.//*[@data-icon='send'] or .//*[@data-testid='send'] or .//*[@aria-label='Send'] or .//*[@aria-label='Enviar'] or .//*[@title='Send'] or .//*[@title='Enviar']) and (.//*[@data-icon='x'] or .//*[@data-icon='back'] or .//*[@aria-label='Close'] or .//*[@aria-label='Fechar'] or .//*[@aria-label='Cerrar'])";
    const captionSemantics =
      ".//*[@data-testid='media-caption-input-container'] or .//*[@contenteditable='true'][@role='textbox'][contains(translate(@aria-label, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'caption') or contains(translate(@aria-label, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'legenda') or contains(translate(@aria-label, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'comentario') or contains(translate(@aria-placeholder, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'caption') or contains(translate(@aria-placeholder, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'legenda') or contains(translate(@aria-placeholder, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'comentario')]";
    const semanticOverlayAncestor = `xpath=ancestor::*[${controls} and (${captionSemantics}) and not(@id='main')][1]`;
    const explicitOverlayAncestor = `xpath=ancestor-or-self::*[(@role='dialog' or @aria-modal='true' or @data-testid='media-editor') and ${controls} and (${captionSemantics})][1]`;
    for (const selector of whatsappWebStableSelectors.mediaSurface) {
      const surfaces = this.page.locator(selector);
      const count = await surfaces.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const surface = surfaces.nth(index);
        if (
          (await surface.isVisible().catch(() => false)) &&
          (await this.hasPositiveBoundingBox(surface)) &&
          (await this.overlayContainsMediaControls(surface)) &&
          (await this.overlayContainsVisiblePreview(surface)) &&
          (await this.overlayContainsCaptionCandidate(surface))
        ) {
          return surface;
        }
      }
    }
    for (const selector of whatsappWebStableSelectors.mediaPreview) {
      const previews = this.page.locator(selector);
      const count = await previews.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const preview = previews.nth(index);
        if (!(await preview.isVisible().catch(() => false))) continue;
        for (const ancestor of [
          explicitOverlayAncestor,
          semanticOverlayAncestor,
        ]) {
          const overlay = preview.locator(ancestor).first();
          if (
            (await overlay.count().catch(() => 0)) === 1 &&
            (await overlay.isVisible().catch(() => false)) &&
            (await this.hasPositiveBoundingBox(overlay))
          ) {
            return overlay;
          }
        }
      }
    }
    return null;
  }

  private async overlayContainsMediaControls(overlay: Locator) {
    const send = await this.firstVisible([
      ...whatsappWebAccessibleAliases.send.map((name) =>
        overlay.getByRole("button", { name, exact: true }),
      ),
      ...whatsappWebStableSelectors.mediaSendTrigger.map((selector) =>
        overlay.locator(selector),
      ),
    ]);
    if (!send) return false;
    return Boolean(
      await this.firstVisible([
        ...whatsappWebAccessibleAliases.close.map((name) =>
          overlay.getByRole("button", { name, exact: true }),
        ),
        ...whatsappWebAccessibleAliases.back.map((name) =>
          overlay.getByRole("button", { name, exact: true }),
        ),
        ...whatsappWebStableSelectors.mediaClose.map((selector) =>
          overlay.locator(selector),
        ),
      ]),
    );
  }

  private async overlayContainsVisiblePreview(overlay: Locator) {
    return Boolean(
      await this.firstVisible(
        whatsappWebStableSelectors.mediaPreview.map((selector) =>
          overlay.locator(selector),
        ),
      ),
    );
  }

  private async overlayContainsCaptionCandidate(overlay: Locator) {
    return Boolean(await this.firstVisible(this.captionStrategies(overlay)));
  }

  private captionStrategies(overlay: Locator) {
    return [
      ...whatsappWebAccessibleAliases.caption.map((name) =>
        overlay.getByRole("textbox", { name, exact: false }),
      ),
      overlay.locator(
        "[data-testid='media-caption-input-container'] [contenteditable='true']",
      ),
      overlay.locator(
        "[contenteditable='true'][role='textbox'][aria-placeholder*='caption' i], [contenteditable='true'][role='textbox'][aria-placeholder*='legenda' i], [contenteditable='true'][role='textbox'][aria-placeholder*='comentario' i]",
      ),
      overlay.locator(
        "[contenteditable='true'][role='textbox'][aria-label*='caption' i], [contenteditable='true'][role='textbox'][aria-label*='legenda' i], [contenteditable='true'][role='textbox'][aria-label*='comentario' i]",
      ),
      overlay.locator("[contenteditable='true'][data-tab='10']"),
      overlay.locator("[contenteditable='true'][role='textbox']"),
      overlay.locator("[contenteditable='true']"),
    ];
  }

  private async resolveVisibleCaptionTarget(input?: {
    requireActive?: boolean;
    expectedText?: string;
  }): Promise<VisualCaptionTarget> {
    if (this.mediaEditorBaselineCaptured) {
      return this.resolveLayoutCaptionTarget(input);
    }
    const overlay = await this.findActiveMediaOverlay();
    if (!overlay) {
      throw await this.stageError(
        "CAPTION_NOT_INSIDE_MEDIA_OVERLAY",
        {},
        {
          captionInsideMediaOverlay: false,
          captionOverlayScoped: false,
        },
      );
    }
    let lastStage: WhatsAppWebDiagnosticStage =
      "CAPTION_VISUAL_TARGET_NOT_CONFIRMED";
    let lastDiagnostics: WhatsAppWebSafeDiagnostics = {
      currentOrigin: "https://web.whatsapp.com",
      captionOverlayScoped: true,
    };
    let candidateOrdinal = 0;
    for (const strategy of this.captionStrategies(overlay)) {
      const count = await strategy.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const candidate = strategy.nth(index);
        const inspected = await this.inspectCaptionCandidate(
          candidate,
          overlay,
          candidateOrdinal,
          count,
        );
        candidateOrdinal += 1;
        lastStage = inspected.stage;
        lastDiagnostics = inspected.diagnostics;
        if (!inspected.accepted) {
          if (input?.expectedText) {
            const hiddenText = await this.readEditableText(candidate);
            if (hiddenText === input.expectedText) {
              throw await this.stageError(
                "CAPTION_HIDDEN_FALSE_POSITIVE",
                {},
                {
                  ...inspected.diagnostics,
                  captionVisibleTextLength: hiddenText.length,
                  captionVisibleTextConfirmed: false,
                  captionExactSnapshotConfirmed: false,
                },
              );
            }
          }
          continue;
        }
        if (input?.requireActive && !(await this.isActiveEditable(candidate))) {
          lastStage = "CAPTION_FOCUS_NOT_CONFIRMED";
          lastDiagnostics = {
            ...inspected.diagnostics,
            captionActiveElementConfirmed: false,
          };
          continue;
        }
        return {
          locator: candidate,
          overlay,
          diagnostics: {
            ...inspected.diagnostics,
            captionCandidateCount: candidateOrdinal,
            captionOverlayScoped: true,
            captionTopmostConfirmed: true,
            captionActiveElementConfirmed: input?.requireActive
              ? true
              : (inspected.diagnostics.captionActiveElementConfirmed ?? false),
          },
        };
      }
    }
    throw await this.stageError(lastStage, {}, lastDiagnostics);
  }

  private async resolveLayoutCaptionTarget(input?: {
    requireActive?: boolean;
    expectedText?: string;
  }): Promise<VisualCaptionTarget> {
    const layout = await this.inspectMediaLayout();
    if (layout.status === "CAPTION_TARGET_AMBIGUOUS") {
      throw await this.stageError(
        "CAPTION_TARGET_AMBIGUOUS",
        {},
        {
          captionCandidateCount: layout.captionCandidateCount,
          captionOverlayScoped: false,
        },
      );
    }
    if (layout.selectedCaptionCandidateIndex === null) {
      throw await this.stageError(
        "CAPTION_TARGET_NOT_RESOLVED",
        {},
        {
          captionCandidateCount: layout.captionCandidateCount,
          previewDetected: layout.previewFound,
          captionOverlayScoped: false,
        },
      );
    }
    const candidateDiagnostic = layout.captionCandidates.find(
      (candidate) =>
        candidate.candidateIndex === layout.selectedCaptionCandidateIndex,
    );
    if (!candidateDiagnostic) {
      throw await this.stageError("CAPTION_TARGET_NOT_RESOLVED");
    }
    const candidate = this.page
      .locator("[contenteditable='true']")
      .nth(layout.selectedCaptionCandidateIndex);
    const active = await this.isActiveEditable(candidate);
    if (input?.requireActive && !active) {
      throw await this.stageError(
        "CAPTION_FOCUS_NOT_CONFIRMED",
        {},
        {
          captionCandidateCount: layout.captionCandidateCount,
          captionCandidateIndex: candidateDiagnostic.candidateIndex,
          captionOverlayScoped: true,
          captionTopmostConfirmed:
            candidateDiagnostic.relationships.topmostAtCenter,
          captionActiveElementConfirmed: false,
        },
      );
    }
    if (input?.expectedText) {
      const visibleText = await this.readEditableText(candidate);
      if (
        visibleText === input.expectedText &&
        !candidateDiagnostic.relationships.topmostAtCenter
      ) {
        throw await this.stageError("CAPTION_HIDDEN_FALSE_POSITIVE");
      }
    }
    return {
      locator: candidate,
      overlay: this.page.locator("body"),
      diagnostics: {
        currentOrigin: "https://web.whatsapp.com",
        captionCandidateCount: layout.captionCandidateCount,
        captionCandidateIndex: candidateDiagnostic.candidateIndex,
        captionTag: candidateDiagnostic.tagName,
        captionRole: candidateDiagnostic.role,
        captionContentEditable: candidateDiagnostic.contentEditable,
        captionBoundingBoxPresent: Boolean(candidateDiagnostic.boundingBox),
        ...(candidateDiagnostic.boundingBox
          ? {
              captionBoundingBoxWidth: candidateDiagnostic.boundingBox.width,
              captionBoundingBoxHeight: candidateDiagnostic.boundingBox.height,
            }
          : {}),
        captionInsideMediaOverlay: true,
        captionTopmostAtCenter:
          candidateDiagnostic.relationships.topmostAtCenter,
        captionActiveElementConfirmed: active,
        captionAttachedBeforeFill: candidateDiagnostic.attached,
        captionAccessibleTextLength: 0,
        captionInputFound: true,
        captionInputVisible: candidateDiagnostic.visible,
        captionInputEditable: candidateDiagnostic.editable,
        captionOverlayScoped: true,
        captionTopmostConfirmed:
          candidateDiagnostic.relationships.topmostAtCenter,
      },
    };
  }

  private async inspectCaptionCandidate(
    candidate: Locator,
    overlay: Locator,
    index: number,
    candidateCount: number,
  ) {
    const visible = await candidate.isVisible().catch(() => false);
    const editable = await candidate.isEditable().catch(() => false);
    const box = await candidate.boundingBox().catch(() => null);
    const handle = await candidate.elementHandle().catch(() => null);
    const elementState = handle
      ? await handle
          .evaluate((element) => {
            const active = document.activeElement;
            const ariaHidden = Boolean(element.closest("[aria-hidden='true']"));
            return {
              attached: element.isConnected,
              tag: element.tagName.toLowerCase(),
              role: element.getAttribute("role"),
              contentEditable: element.getAttribute("contenteditable"),
              ariaHidden,
              active:
                active === element ||
                (active instanceof Node && element.contains(active)),
              accessibleTextLength: (
                element.getAttribute("aria-label") ??
                element.getAttribute("aria-placeholder") ??
                ""
              ).length,
            };
          })
          .catch(() => null)
      : null;
    const insideOverlay =
      handle && elementState?.attached
        ? await overlay
            .evaluate(
              (root, element) => root === element || root.contains(element),
              handle,
            )
            .catch(() => false)
        : false;
    const topmost =
      handle && box && box.width > 0 && box.height > 0
        ? await handle
            .evaluate((element) => {
              const rect = element.getBoundingClientRect();
              const x = rect.left + rect.width / 2;
              const y = rect.top + rect.height / 2;
              if (
                x < 0 ||
                y < 0 ||
                x >= window.innerWidth ||
                y >= window.innerHeight
              ) {
                return false;
              }
              const hit = document.elementFromPoint(x, y);
              return Boolean(hit && (hit === element || element.contains(hit)));
            })
            .catch(() => false)
        : false;
    await handle?.dispose().catch(() => undefined);
    const diagnostics: WhatsAppWebSafeDiagnostics = {
      currentOrigin: "https://web.whatsapp.com",
      captionCandidateCount: candidateCount,
      captionCandidateIndex: index,
      captionTag: elementState?.tag ?? null,
      captionRole: elementState?.role ?? null,
      captionContentEditable: elementState?.contentEditable ?? null,
      captionBoundingBoxPresent: Boolean(
        box && box.width > 0 && box.height > 0,
      ),
      captionBoundingBoxWidth: box?.width ?? 0,
      captionBoundingBoxHeight: box?.height ?? 0,
      captionInsideMediaOverlay: insideOverlay,
      captionTopmostAtCenter: topmost,
      captionActiveElementConfirmed: elementState?.active ?? false,
      captionAttachedBeforeFill: elementState?.attached ?? false,
      captionAccessibleTextLength: elementState?.accessibleTextLength ?? 0,
      captionInputFound: true,
      captionInputVisible: visible,
      captionInputEditable: editable,
      captionOverlayScoped: insideOverlay,
      captionTopmostConfirmed: topmost,
    };
    if (!insideOverlay) {
      return {
        accepted: false,
        stage: "CAPTION_NOT_INSIDE_MEDIA_OVERLAY" as const,
        diagnostics,
      };
    }
    if (
      !visible ||
      !editable ||
      !elementState?.attached ||
      elementState.ariaHidden ||
      !box ||
      box.width <= 0 ||
      box.height <= 0
    ) {
      return {
        accepted: false,
        stage: "CAPTION_VISUAL_TARGET_NOT_CONFIRMED" as const,
        diagnostics,
      };
    }
    if (!topmost) {
      return {
        accepted: false,
        stage: "CAPTION_NOT_TOPMOST" as const,
        diagnostics,
      };
    }
    return {
      accepted: true,
      stage: "DRY_RUN_READY" as const,
      diagnostics,
    };
  }

  private async isActiveEditable(candidate: Locator) {
    return candidate
      .evaluate((element) => {
        const active = document.activeElement;
        return (
          active === element ||
          (active instanceof Node && element.contains(active))
        );
      })
      .catch(() => false);
  }

  private async observeVisibleCaption(input: {
    expected: string;
    affiliateUrl: string;
    textSnippet: string;
    requireActive: boolean;
  }) {
    const target = await this.resolveVisibleCaptionTarget({
      requireActive: input.requireActive,
      expectedText: input.expected,
    });
    const text = await this.readEditableText(target.locator);
    const affiliateUrlOccurrenceCount =
      text.split(input.affiliateUrl).length - 1;
    return {
      target,
      text,
      textLength: text.length,
      exact: text === input.expected,
      affiliateUrlOccurrenceCount,
      titleSnippetConfirmed: text.includes(normalizedText(input.textSnippet)),
    };
  }

  private async hasPositiveBoundingBox(locator: Locator) {
    const box = await locator.boundingBox().catch(() => null);
    return Boolean(box && box.width > 0 && box.height > 0);
  }

  private async inspectActionableElement(candidate: Locator, scope: Locator) {
    const visible = await candidate.isVisible().catch(() => false);
    const enabled = await candidate.isEnabled().catch(() => false);
    const box = await candidate.boundingBox().catch(() => null);
    const handle = await candidate.elementHandle().catch(() => null);
    const attached = handle
      ? await handle
          .evaluate((element) => element.isConnected)
          .catch(() => false)
      : false;
    const insideScope =
      handle && attached
        ? await scope
            .evaluate(
              (root, element) => root === element || root.contains(element),
              handle,
            )
            .catch(() => false)
        : false;
    const topmost =
      handle && box && box.width > 0 && box.height > 0 && insideScope
        ? await handle
            .evaluate((element) => {
              const rect = element.getBoundingClientRect();
              const x = rect.left + rect.width / 2;
              const y = rect.top + rect.height / 2;
              if (
                x < 0 ||
                y < 0 ||
                x >= window.innerWidth ||
                y >= window.innerHeight
              ) {
                return false;
              }
              const hit = document.elementFromPoint(x, y);
              return Boolean(hit && (hit === element || element.contains(hit)));
            })
            .catch(() => false)
        : false;
    await handle?.dispose().catch(() => undefined);
    return {
      visible,
      enabled,
      attached,
      boundingBoxPresent: Boolean(box && box.width > 0 && box.height > 0),
      topmost,
    };
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
    let lastCaptionError: WhatsAppWebStageError | null = null;
    do {
      const preview = await this.firstVisible(
        whatsappWebStableSelectors.mediaPreview.map((selector) =>
          this.page.locator(selector),
        ),
      );
      const loading = await this.hasMediaUploadInProgress();
      const caption = await this.resolveVisibleCaptionTarget().catch(
        (error) => {
          if (error instanceof WhatsAppWebStageError) {
            lastCaptionError = error;
          }
          return null;
        },
      );
      if (preview && caption && !loading) {
        stableObservations += 1;
        if (stableObservations >= 2) return;
      } else {
        stableObservations = 0;
      }
      await this.page.waitForTimeout(150);
    } while (Date.now() < deadline);
    if (lastCaptionError) throw lastCaptionError;
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
