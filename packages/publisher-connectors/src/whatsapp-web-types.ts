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
  }): Promise<BrowserSession>;
}

export interface WhatsAppWebProfileLock {
  acquire(profileKey: string, ttlMs: number): Promise<LockHandle>;
}
