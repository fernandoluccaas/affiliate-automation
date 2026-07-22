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
  status: "PUBLISHED" | "FAILED";
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
    return { externalId: payload.offerId, status: "PUBLISHED" as const };
  }

  async getPublicationStatus(externalId: string) {
    return { externalId, status: "PUBLISHED" as const };
  }

  async retry(publicationId: string) {
    return { externalId: publicationId, status: "PUBLISHED" as const };
  }

  async healthCheck() {
    return true;
  }
}
