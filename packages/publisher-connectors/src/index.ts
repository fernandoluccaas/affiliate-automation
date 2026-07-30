export type PublicationPayload = {
  offerId: string;
  channelId: string;
  headline?: string;
  body?: string;
  callToAction?: string;
  disclosure?: string;
  hashtags?: string[];
  trackingUrl: string;
  message: string;
  imageUrl?: string | null;
};

export type PublisherResult = {
  externalId?: string | undefined;
  status: "PUBLISHED" | "FAILED" | "EXPORTED";
  rawResponse?: unknown;
  errorMessage?: string | undefined;
  failureKind?: "TRANSIENT" | "PERMANENT" | undefined;
  errorCode?: string | undefined;
  retryAfterSeconds?: number | undefined;
};

export interface PublisherAdapter {
  validateCredentials(): Promise<boolean>;
  publish(payload: PublicationPayload): Promise<PublisherResult>;
  getPublicationStatus(externalId: string): Promise<PublisherResult>;
  retry(
    publicationId: string,
    payload?: PublicationPayload,
  ): Promise<PublisherResult>;
  healthCheck(): Promise<boolean>;
}

type TelegramConfig = {
  botToken?: string | undefined;
  chatId?: string | undefined;
  timeoutMs?: number;
};

type TelegramApiResponse = {
  ok?: boolean;
  description?: string;
  error_code?: number;
  httpStatus?: number;
  transientFailure?: boolean;
  parameters?: {
    retry_after?: number;
  };
  result?: {
    message_id?: number;
    [key: string]: unknown;
  };
};

function sanitizeTelegramResponse(response: TelegramApiResponse) {
  return {
    ok: response.ok,
    errorCode: response.error_code,
    retryAfterSeconds: response.parameters?.retry_after,
    messageId: response.result?.message_id,
  };
}

function telegramFailure(response: TelegramApiResponse) {
  const retryAfterSeconds = response.parameters?.retry_after;
  const transient =
    response.transientFailure === true ||
    response.error_code === 429 ||
    response.httpStatus === 429 ||
    (response.httpStatus !== undefined && response.httpStatus >= 500);

  return {
    failureKind: transient ? ("TRANSIENT" as const) : ("PERMANENT" as const),
    errorCode:
      response.error_code !== undefined
        ? `TELEGRAM_${response.error_code}`
        : response.httpStatus !== undefined
          ? `TELEGRAM_HTTP_${response.httpStatus}`
          : "TELEGRAM_REQUEST_FAILED",
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  };
}

function isValidHttpUrl(value?: string | null) {
  if (!value) {
    return false;
  }

  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export class TelegramPublisher implements PublisherAdapter {
  private readonly botToken: string | undefined;
  private readonly chatId: string | undefined;
  private readonly timeoutMs: number;

  constructor(config: TelegramConfig = {}) {
    this.botToken = config.botToken ?? process.env.TELEGRAM_BOT_TOKEN;
    this.chatId = config.chatId ?? process.env.TELEGRAM_CHAT_ID;
    this.timeoutMs = config.timeoutMs ?? 8000;
  }

  async validateCredentials() {
    if (!this.botToken || !this.chatId) {
      return false;
    }

    return this.healthCheck();
  }

  async healthCheck() {
    if (!this.botToken || !this.chatId) {
      return false;
    }

    const response = await this.request("getMe", {});
    return response.ok === true;
  }

  async publish(payload: PublicationPayload) {
    if (!this.botToken || !this.chatId) {
      return {
        status: "FAILED" as const,
        failureKind: "PERMANENT" as const,
        errorCode: "TELEGRAM_CREDENTIALS_MISSING",
        errorMessage: "Telegram credentials are not configured.",
      };
    }

    if (isValidHttpUrl(payload.imageUrl)) {
      const imageResult = await this.sendPhoto(payload);

      if (
        imageResult.status === "PUBLISHED" ||
        imageResult.failureKind === "TRANSIENT"
      ) {
        return imageResult;
      }
    }

    return this.sendMessage(payload.message);
  }

  async getPublicationStatus(externalId: string) {
    return {
      externalId,
      status: "PUBLISHED" as const,
      rawResponse: { statusLookupSupported: false },
    };
  }

  async retry(publicationId: string, payload?: PublicationPayload) {
    if (!payload) {
      return {
        externalId: publicationId,
        status: "FAILED" as const,
        errorMessage: "Retry requires the original publication payload.",
      };
    }

    return this.publish(payload);
  }

  private async sendPhoto(
    payload: PublicationPayload,
  ): Promise<PublisherResult> {
    const response = await this.request("sendPhoto", {
      chat_id: this.chatId,
      photo: payload.imageUrl,
      caption: payload.message,
    });

    if (response.ok) {
      return {
        externalId: response.result?.message_id
          ? String(response.result.message_id)
          : undefined,
        status: "PUBLISHED",
        rawResponse: sanitizeTelegramResponse(response),
      };
    }

    return {
      status: "FAILED",
      rawResponse: sanitizeTelegramResponse(response),
      errorMessage:
        response.description ?? "Telegram image publication failed.",
      ...telegramFailure(response),
    };
  }

  private async sendMessage(message: string): Promise<PublisherResult> {
    const response = await this.request("sendMessage", {
      chat_id: this.chatId,
      text: message,
      disable_web_page_preview: false,
    });

    if (response.ok) {
      return {
        externalId: response.result?.message_id
          ? String(response.result.message_id)
          : undefined,
        status: "PUBLISHED",
        rawResponse: sanitizeTelegramResponse(response),
      };
    }

    return {
      status: "FAILED",
      rawResponse: sanitizeTelegramResponse(response),
      errorMessage: response.description ?? "Telegram text publication failed.",
      ...telegramFailure(response),
    };
  }

  private async request(method: string, payload: Record<string, unknown>) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(
        `https://api.telegram.org/bot${this.botToken}/${method}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify(payload),
          signal: controller.signal,
        },
      );

      const body = (await response.json().catch(() => ({
        ok: false,
        description: `Telegram HTTP ${response.status}`,
      }))) as TelegramApiResponse;

      if (!response.ok) {
        return {
          ...body,
          ok: false,
          httpStatus: response.status,
          description: body.description ?? `Telegram HTTP ${response.status}`,
        };
      }

      return body;
    } catch (error) {
      return {
        ok: false,
        transientFailure: true,
        description:
          error instanceof Error && error.name === "AbortError"
            ? "Telegram request timed out."
            : "Telegram request failed.",
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class ManualExportPublisher implements PublisherAdapter {
  async validateCredentials() {
    return true;
  }

  async publish(payload: PublicationPayload) {
    return {
      externalId: `manual-export:${payload.offerId}`,
      status: "EXPORTED" as const,
      rawResponse: {
        exportedOnly: true,
        message: payload.message,
      },
    };
  }

  async getPublicationStatus(externalId: string) {
    return {
      externalId,
      status: "EXPORTED" as const,
      rawResponse: { exportedOnly: true },
    };
  }

  async retry(publicationId: string) {
    return {
      externalId: `manual-export:${publicationId}`,
      status: "EXPORTED" as const,
      rawResponse: { exportedOnly: true },
    };
  }

  async healthCheck() {
    return true;
  }
}
