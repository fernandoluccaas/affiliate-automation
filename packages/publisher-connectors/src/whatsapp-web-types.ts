import type { LockHandle } from "@affiliate/redis";

export type WhatsAppWebErrorCode =
  | "WHATSAPP_WEB_DISABLED"
  | "WHATSAPP_WEB_GLOBAL_FEATURE_DISABLED"
  | "WHATSAPP_WEB_REAL_SEND_DISABLED_BY_DRY_RUN"
  | "WHATSAPP_WEB_CHANNEL_DISABLED"
  | "WHATSAPP_WEB_CHANNEL_PAUSED"
  | "WHATSAPP_WEB_AUTOMATION_DISABLED"
  | "WHATSAPP_WEB_CHANNEL_TYPE_INVALID"
  | "WHATSAPP_WEB_PUBLICATION_MODE_INVALID"
  | "WHATSAPP_WEB_CONFIRM_SEND_REQUIRED"
  | "WHATSAPP_WEB_DRY_RUN_REQUIRED"
  | "WHATSAPP_WEB_DRY_RUN_FINGERPRINT_INVALID"
  | "WHATSAPP_WEB_PUBLICATION_ALREADY_PUBLISHED"
  | "WHATSAPP_WEB_PUBLICATION_INELIGIBLE"
  | "WHATSAPP_WEB_RETRY_NOT_AUTHORIZED"
  | "WHATSAPP_WEB_VISUAL_DRAFT_INSPECTION_REQUIRED"
  | "WHATSAPP_WEB_BROWSER_UNAVAILABLE"
  | "WHATSAPP_WEB_PROFILE_NOT_INITIALIZED"
  | "WHATSAPP_WEB_LOGIN_REQUIRED"
  | "WHATSAPP_WEB_PROFILE_IN_USE"
  | "WHATSAPP_WEB_OWNERSHIP_NOT_CONFIRMED"
  | "WHATSAPP_WEB_GROUP_NOT_FOUND"
  | "WHATSAPP_WEB_GROUP_AMBIGUOUS"
  | "WHATSAPP_WEB_NO_PUBLISH_PERMISSION"
  | "WHATSAPP_WEB_SELECTOR_MISMATCH"
  | "WHATSAPP_WEB_MEDIA_PREPARATION_FAILED"
  | "WHATSAPP_WEB_MEDIA_UPLOAD_FAILED"
  | "WHATSAPP_WEB_DRAFT_VALIDATION_FAILED"
  | "WHATSAPP_WEB_DRAFT_CLEANUP_FAILED"
  | "WHATSAPP_WEB_PRE_SEND_VALIDATION_FAILED"
  | "WHATSAPP_WEB_SEND_TRIGGER_FAILED"
  | "WHATSAPP_WEB_SEND_STATE_PERSIST_FAILED"
  | "WHATSAPP_WEB_SEND_FAILED"
  | "WHATSAPP_WEB_CONFIRMATION_TIMEOUT"
  | "WHATSAPP_WEB_DELIVERY_UNCERTAIN"
  | "WHATSAPP_WEB_UNEXPECTED_STATE"
  | "REDIS_UNAVAILABLE"
  | "LOCK_ALREADY_HELD";

export type WhatsAppWebHealthStatus =
  | "DISABLED"
  | "BROWSER_UNAVAILABLE"
  | "NOT_INITIALIZED"
  | "LOGIN_REQUIRED"
  | "CONNECTED"
  | "PROFILE_IN_USE"
  | "REDIS_UNAVAILABLE"
  | "UNEXPECTED_STATE"
  | "ERROR";

export type WhatsAppWebHealthResult = {
  status: WhatsAppWebHealthStatus;
  checkedAt: string;
  errorCode?: WhatsAppWebErrorCode;
};

export type WhatsAppWebDiagnosticStage =
  | "APP_SHELL_NOT_FOUND"
  | "AUTHENTICATED_SHELL_NOT_RECOGNIZED"
  | "SEARCH_TRIGGER_NOT_FOUND"
  | "SEARCH_TRIGGER_NOT_INTERACTABLE"
  | "SEARCH_OPEN_FAILED"
  | "SEARCH_INPUT_NOT_FOUND"
  | "SEARCH_INPUT_NOT_VISIBLE"
  | "SEARCH_INPUT_NOT_EDITABLE"
  | "SEARCH_RESULTS_CONTAINER_NOT_FOUND"
  | "SEARCH_RESULTS_NOT_READY"
  | "EXACT_GROUP_RESULT_NOT_FOUND"
  | "MULTIPLE_EXACT_GROUP_RESULTS"
  | "GROUP_RESULT_NOT_INTERACTABLE"
  | "GROUP_OPEN_FAILED"
  | "GROUP_REOPEN_FAILED"
  | "GROUP_HEADER_NOT_FOUND"
  | "GROUP_HEADER_MISMATCH"
  | "COMPOSER_NOT_FOUND"
  | "ATTACH_TRIGGER_NOT_FOUND"
  | "ATTACH_MENU_NOT_FOUND"
  | "IMAGE_OPTION_NOT_FOUND"
  | "FILE_INPUT_NOT_FOUND"
  | "FILE_CHOOSER_NOT_OPENED"
  | "FILE_NOT_WRITTEN"
  | "FILE_NOT_FOUND_ON_DISK"
  | "FILE_SIZE_ZERO"
  | "FILE_MIME_INVALID"
  | "MEDIA_UPLOAD_FAILED"
  | "MEDIA_PREVIEW_NOT_FOUND"
  | "CAPTION_INPUT_NOT_FOUND"
  | "CAPTION_NOT_EDITABLE"
  | "CAPTION_INPUT_RECREATED"
  | "CAPTION_CONTENT_LOST"
  | "CAPTION_CONTENT_MISMATCH"
  | "CAPTION_VISUAL_TARGET_NOT_CONFIRMED"
  | "CAPTION_NOT_INSIDE_MEDIA_OVERLAY"
  | "CAPTION_NOT_TOPMOST"
  | "CAPTION_FOCUS_NOT_CONFIRMED"
  | "CAPTION_VISIBLE_TEXT_MISSING"
  | "CAPTION_VISIBLE_TEXT_MISMATCH"
  | "CAPTION_HIDDEN_FALSE_POSITIVE"
  | "CAPTION_TARGET_NOT_RESOLVED"
  | "CAPTION_TARGET_AMBIGUOUS"
  | "LAYOUT_INSPECTION_READY"
  | "VISUAL_DRAFT_REJECTED"
  | "DRAFT_VALIDATION_FAILED"
  | "DRAFT_CLEANUP_FAILED"
  | "PUBLISH_PERMISSION_UNDETERMINED"
  | "READY_FOR_GROUP_SEARCH"
  | "GROUP_FOUND"
  | "DRY_RUN_READY"
  | "READY_TO_COMMIT_SEND"
  | "PRE_SEND_VALIDATION_STARTED"
  | "PRE_SEND_GROUP_MISMATCH"
  | "PRE_SEND_MEDIA_PREVIEW_MISSING"
  | "PRE_SEND_MEDIA_UPLOAD_IN_PROGRESS"
  | "PRE_SEND_CAPTION_MISSING"
  | "PRE_SEND_AFFILIATE_URL_MISSING"
  | "SEND_TRIGGER_NOT_FOUND"
  | "SEND_TRIGGER_NOT_VISIBLE"
  | "SEND_TRIGGER_DISABLED"
  | "SEND_TRIGGER_NOT_INTERACTABLE"
  | "SEND_TRIGGER_AMBIGUOUS"
  | "SEND_TRIGGER_TRIAL_FAILED"
  | "SEND_TRIGGER_INTERCEPTED"
  | "SEND_TRIGGER_STALE"
  | "SEND_TRIGGER_NOT_TOPMOST"
  | "SEND_CLICK_STARTED"
  | "SEND_CLICK_FAILED"
  | "SEND_CLICK_COMPLETED"
  | "SEND_STATE_PERSIST_FAILED"
  | "DELIVERY_CONFIRMATION_STARTED"
  | "OUTGOING_MESSAGE_NOT_FOUND"
  | "OUTGOING_MEDIA_NOT_CONFIRMED"
  | "OUTGOING_TEXT_NOT_CONFIRMED"
  | "OUTGOING_AFFILIATE_URL_NOT_CONFIRMED"
  | "DELIVERY_CONFIRMATION_TIMEOUT"
  | "DELIVERY_CONFIRMED"
  | "DELIVERY_UNCERTAIN";

export type WhatsAppWebAttachStrategy =
  "DIRECT_FILE_CHOOSER" | "IMAGE_OPTION_FILE_CHOOSER" | "SET_INPUT_FILES";

export type WhatsAppWebSafeDiagnostics = {
  currentOrigin: "https://web.whatsapp.com";
  interfaceLanguage?: "pt" | "en" | "es" | "unknown";
  shellRecognized?: boolean;
  strategiesTried?: number;
  candidateCount?: number;
  visible?: boolean;
  enabled?: boolean;
  editable?: boolean;
  exactMatchCount?: number;
  durationMs?: number;
  errorCode?: WhatsAppWebErrorCode;
  rootCause?: WhatsAppWebDiagnosticStage;
  attachStrategyUsed?: WhatsAppWebAttachStrategy;
  usedFileChooser?: boolean;
  usedSetInputFiles?: boolean;
  tempFileExists?: boolean;
  tempFileSize?: number;
  tempFileExtension?: string;
  previewDetected?: boolean;
  captionDetected?: boolean;
  captionInputFound?: boolean;
  captionInputVisible?: boolean;
  captionInputEditable?: boolean;
  captionFillAttempts?: number;
  captionStable?: boolean;
  captionLengthExpected?: number;
  captionLengthObserved?: number;
  affiliateUrlOccurrenceCount?: number;
  titleSnippetConfirmed?: boolean;
  captionCandidateCount?: number;
  captionCandidateIndex?: number;
  captionTag?: string | null;
  captionRole?: string | null;
  captionContentEditable?: string | null;
  captionBoundingBoxPresent?: boolean;
  captionBoundingBoxWidth?: number;
  captionBoundingBoxHeight?: number;
  captionInsideMediaOverlay?: boolean;
  captionTopmostAtCenter?: boolean;
  captionActiveElementConfirmed?: boolean;
  captionAttachedBeforeFill?: boolean;
  captionAttachedAfterFill?: boolean;
  captionReResolvedAfterFill?: boolean;
  captionVisibleTextLength?: number;
  captionAccessibleTextLength?: number;
  captionVisibleTextConfirmed?: boolean;
  captionOverlayScoped?: boolean;
  captionTopmostConfirmed?: boolean;
  captionExactSnapshotConfirmed?: boolean;
  sendTriggerBoundingBoxPresent?: boolean;
  sendTriggerTopmostConfirmed?: boolean;
  sendTriggerTrialSucceeded?: boolean;
  uploadInProgressVisible?: boolean;
  draftValidated?: boolean;
  draftCleared?: boolean;
  uploadErrorVisible?: boolean;
  affiliateUrlOccurrences?: number;
  closeTriggerFound?: boolean;
  escapeUsed?: boolean;
  discardTriggerFound?: boolean;
  activeMediaCaptionFound?: boolean;
  discardTriggerVisible?: boolean;
  normalComposerEmpty?: boolean;
};

export type WhatsAppWebMediaAttachmentResult = {
  attachStrategyUsed: WhatsAppWebAttachStrategy;
  usedFileChooser: boolean;
  usedSetInputFiles: boolean;
  previewDetected: true;
};

export type WhatsAppWebCaptionResult = {
  captionDetected: true;
  captionInputFound: true;
  captionInputVisible: true;
  captionInputEditable: true;
  captionFillAttempts: number;
  captionStable: true;
  captionLengthExpected: number;
  captionLengthObserved: number;
  affiliateUrlOccurrenceCount: number;
  titleSnippetConfirmed: true;
  captionVisibleTextConfirmed: true;
  captionOverlayScoped: true;
  captionTopmostConfirmed: true;
  captionActiveElementConfirmed: true;
  captionExactSnapshotConfirmed: true;
};

export type WhatsAppWebDraftCleanupResult = {
  closeTriggerFound: boolean;
  escapeUsed: boolean;
  discardTriggerFound: boolean;
};

export type WhatsAppWebLayoutCandidateReason =
  | "ACTIVE_MEDIA_CAPTION_CANDIDATE"
  | "NORMAL_CHAT_COMPOSER_BEHIND_OVERLAY"
  | "EXISTED_BEFORE_MEDIA_EDITOR"
  | "NOT_SEMANTIC_CAPTION"
  | "NOT_VISIBLE_OR_EDITABLE"
  | "OUTSIDE_VIEWPORT"
  | "NOT_TOPMOST"
  | "DIFFERENT_STACKING_CONTEXT"
  | "NOT_ASSOCIATED_WITH_MEDIA_CONTROLS"
  | "CAPTION_TARGET_AMBIGUOUS";

export type WhatsAppWebLayoutElementDiagnostic = {
  candidateIndex: number;
  tagName: string;
  role: string | null;
  contentEditable: string | null;
  ariaHidden: boolean;
  disabled: boolean;
  attached: boolean;
  visible: boolean;
  editable: boolean;
  boundingBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null;
  computedStyle: {
    display: string;
    visibility: string;
    opacity: string;
    position: string;
    zIndex: string;
    pointerEvents: string;
  };
  relationships: {
    containsPreview: boolean;
    containsSendTrigger: boolean;
    containsCloseTrigger: boolean;
    containsCaptionCandidate: boolean;
    commonAncestorDepthWithPreview: number | null;
    commonAncestorDepthWithSend: number | null;
    sameTopLevelSurfaceAsPreview: boolean;
    sameStackingContextAsPreview: boolean;
    sameStackingContextAsSend: boolean;
    overlapsPreview: boolean;
    verticallyAdjacentToPreview: boolean;
    horizontallyAlignedWithPreview: boolean;
    insideViewport: boolean;
    topmostAtCenter: boolean;
    activeElementOrContainsActiveElement: boolean;
  };
  classNameHash: string;
  dataAttributeNames: string[];
  captionCandidateExistedBeforePreview: boolean;
  captionCandidateCreatedAfterPreview: boolean;
  captionCandidateChangedSurfaceAfterPreview: boolean;
};

export type WhatsAppWebLayoutCandidateDecision = {
  index: number;
  accepted: boolean;
  reason: WhatsAppWebLayoutCandidateReason;
};

export type WhatsAppWebMediaLayoutInspection = {
  status:
    | "LAYOUT_INSPECTION_READY"
    | "CAPTION_TARGET_NOT_RESOLVED"
    | "CAPTION_TARGET_AMBIGUOUS";
  previewFound: boolean;
  sendTriggerFound: boolean;
  sendTriggerCandidateCount: number;
  closeTriggerFound: boolean;
  surfaceCandidateCount: number;
  captionCandidateCount: number;
  selectedCaptionCandidateIndex: number | null;
  candidateDecisions: WhatsAppWebLayoutCandidateDecision[];
  captionCandidates: WhatsAppWebLayoutElementDiagnostic[];
  sendCalled: false;
};

export type WhatsAppWebControlResult = {
  found: boolean;
  stage: WhatsAppWebDiagnosticStage;
  strategiesTried: number;
  visible: boolean;
  enabled: boolean;
  editable?: boolean;
};

export type WhatsAppWebStructureDiagnosticResult = {
  authentication: AuthenticationState;
  shellRecognized: boolean;
  searchTriggerFound: boolean;
  searchInputFound: boolean;
  stage: WhatsAppWebDiagnosticStage;
  diagnostics: WhatsAppWebSafeDiagnostics;
};

export class WhatsAppWebStageError extends Error {
  constructor(
    public readonly stage: WhatsAppWebDiagnosticStage,
    public readonly diagnostics: WhatsAppWebSafeDiagnostics,
    public readonly errorCode: WhatsAppWebErrorCode = "WHATSAPP_WEB_SELECTOR_MISMATCH",
  ) {
    super(errorCode);
    this.name = "WhatsAppWebStageError";
  }
}

export type WhatsAppGroupLocationResult = {
  status:
    | "GROUP_FOUND"
    | "GROUP_NOT_FOUND"
    | "GROUP_AMBIGUOUS"
    | "NO_PUBLISH_PERMISSION"
    | "LOGIN_REQUIRED"
    | "SELECTOR_MISMATCH";
  exactMatch: boolean;
  publishPermission: boolean;
  errorCode?: WhatsAppWebErrorCode;
  stage?: WhatsAppWebDiagnosticStage;
  rootCause?: WhatsAppWebDiagnosticStage;
  diagnostics?: WhatsAppWebSafeDiagnostics;
};

export type AuthenticationState =
  "CONNECTED" | "LOGIN_REQUIRED" | "UNEXPECTED_STATE";

export type PreparedDraftInspection = {
  affiliateUrlFound: boolean;
  affiliateUrlOccurrences: number;
  textSnippetFound: boolean;
  mediaFound: boolean;
  uploadErrorVisible: boolean;
  uploadInProgressVisible: boolean;
  captionStable: boolean;
  captionLengthExpected: number;
  captionLengthObserved: number;
  captionVisibleTextConfirmed: boolean;
  captionOverlayScoped: boolean;
  captionTopmostConfirmed: boolean;
  captionActiveElementConfirmed: boolean;
  captionExactSnapshotConfirmed: boolean;
  diagnostics: WhatsAppWebSafeDiagnostics;
};

export type OutgoingMessageConfirmation = {
  confirmed: boolean;
  affiliateUrlFound: boolean;
  affiliateUrlOccurrences: number;
  textSnippetFound: boolean;
  mediaFound: boolean;
  uploadErrorVisible: boolean;
  stage: WhatsAppWebDiagnosticStage;
};

export type WhatsAppWebSendTriggerInspection = {
  found: boolean;
  visible: boolean;
  enabled: boolean;
  candidateCount: number;
  strategiesTried: number;
  outgoingCount: number;
  boundingBoxPresent: boolean;
  topmostConfirmed: boolean;
  trialClickSucceeded: boolean;
  stage: WhatsAppWebDiagnosticStage;
};

export interface WhatsAppWebPageAdapter {
  navigate(): Promise<void>;
  detectAuthenticationState(): Promise<AuthenticationState>;
  waitForAuthenticatedShell(): Promise<WhatsAppWebControlResult>;
  findGlobalSearchTrigger(): Promise<WhatsAppWebControlResult>;
  findGlobalSearchInput(): Promise<WhatsAppWebControlResult>;
  openGlobalSearch(): Promise<WhatsAppWebControlResult>;
  fillGlobalSearch(text: string): Promise<WhatsAppWebControlResult>;
  waitForSearchResults(): Promise<WhatsAppWebControlResult>;
  diagnoseStructure(): Promise<WhatsAppWebStructureDiagnosticResult>;
  locateGroupExact(name: string): Promise<WhatsAppGroupLocationResult>;
  openGroup(name: string): Promise<void>;
  verifyOpenedGroup(name: string): Promise<boolean>;
  verifyPublishPermission(): Promise<boolean>;
  captureMediaEditorBaseline(): Promise<void>;
  attachImage(path: string): Promise<WhatsAppWebMediaAttachmentResult>;
  inspectMediaLayout(): Promise<WhatsAppWebMediaLayoutInspection>;
  fillCaption(input: {
    text: string;
    affiliateUrl: string;
    textSnippet: string;
  }): Promise<WhatsAppWebCaptionResult>;
  fillText(text: string): Promise<void>;
  inspectPreparedDraft(input: {
    affiliateUrl: string;
    textSnippet: string;
    expectedText: string;
    mediaExpected: boolean;
  }): Promise<PreparedDraftInspection>;
  inspectSendTrigger(input: {
    mediaExpected: boolean;
  }): Promise<WhatsAppWebSendTriggerInspection>;
  holdDraftOpen(ms: number): Promise<void>;
  clickSendTrigger(): Promise<void>;
  confirmOutgoingMessage(input: {
    affiliateUrl: string;
    textSnippet: string;
    mediaExpected: boolean;
    sentAfter: Date;
    outgoingCountBefore: number;
  }): Promise<OutgoingMessageConfirmation>;
  clearDraft(): Promise<WhatsAppWebDraftCleanupResult>;
  isDraftClear(): Promise<boolean>;
  capturePreparedDraft?(path: string): Promise<void>;
}

export type BrowserSession = {
  adapter: WhatsAppWebPageAdapter;
  close(): Promise<void>;
};

export interface WhatsAppWebBrowserLauncher {
  isAvailable(): Promise<boolean>;
  launchPersistent(input: {
    userDataDir: string;
    headless: boolean;
    actionTimeoutMs: number;
    navigationTimeoutMs: number;
    confirmationTimeoutMs: number;
    slowMoMs?: number;
    devtools?: boolean;
  }): Promise<BrowserSession>;
}

export interface WhatsAppWebProfileLock {
  acquire(profileKey: string, ttlMs: number): Promise<LockHandle>;
}
