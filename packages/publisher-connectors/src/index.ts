export type PublicationPayload = {
  offerId: string;
  channelId: string;
  headline: string;
  body: string;
  callToAction: string;
  disclosure: string;
  hashtags: string[];
  trackingUrl: string;
};

export type PublisherResult = {
  externalId?: string;
  status: "PUBLISHED" | "FAILED" | "EXPORTED";
  rawResponse?: unknown;
};

export interface PublisherAdapter {
  validateCredentials(): Promise<boolean>;
  publish(payload: PublicationPayload): Promise<PublisherResult>;
  getPublicationStatus(externalId: string): Promise<PublisherResult>;
  retry(publicationId: string): Promise<PublisherResult>;
  healthCheck(): Promise<boolean>;
}

export class ManualExportPublisher implements PublisherAdapter {
  async validateCredentials() {
    return true;
  }

  async publish(payload: PublicationPayload) {
    return {
      externalId: `manual-export:${payload.offerId}`,
      status: "EXPORTED" as const,
      rawResponse: { exportedOnly: true },
    };
  }

  async getPublicationStatus(externalId: string) {
    return { externalId, status: "EXPORTED" as const, rawResponse: { exportedOnly: true } };
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
