import type { LockHandle } from "@affiliate/redis";

export type WhatsAppWebErrorCode =
  | "WHATSAPP_WEB_DISABLED"
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
  | "GROUP_HEADER_NOT_FOUND"
  | "GROUP_HEADER_MISMATCH"
  | "COMPOSER_NOT_FOUND"
  | "PUBLISH_PERMISSION_UNDETERMINED"
  | "READY_FOR_GROUP_SEARCH"
  | "GROUP_FOUND";

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
  textSnippetFound: boolean;
  mediaFound: boolean;
};

export type OutgoingMessageConfirmation = PreparedDraftInspection & {
  confirmed: boolean;
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
  attachImage(path: string): Promise<void>;
  fillCaption(text: string): Promise<void>;
  fillText(text: string): Promise<void>;
  inspectPreparedDraft(input: {
    affiliateUrl: string;
    textSnippet: string;
    mediaExpected: boolean;
  }): Promise<PreparedDraftInspection>;
  send(): Promise<void>;
  confirmOutgoingMessage(input: {
    affiliateUrl: string;
    textSnippet: string;
    mediaExpected: boolean;
    sentAfter: Date;
  }): Promise<OutgoingMessageConfirmation>;
  clearDraft(): Promise<void>;
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
  }): Promise<BrowserSession>;
}

export interface WhatsAppWebProfileLock {
  acquire(profileKey: string, ttlMs: number): Promise<LockHandle>;
}
