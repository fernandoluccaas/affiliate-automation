import { prisma, Prisma, type PrismaClient } from "@affiliate/database";

export type ControlledShopeeTelegramActivationResult =
  | {
      ok: true;
      status: "ACTIVATED" | "ALREADY_SCHEDULED";
      publicationId: string;
      channelId: string;
    }
  | {
      ok: false;
      code:
        | "SHOPEE_CONTROLLED_PUBLICATION_NOT_FOUND"
        | "SHOPEE_CONTROLLED_PUBLICATION_NOT_ACTIVATABLE"
        | "SHOPEE_CONTROLLED_PUBLICATION_ATTEMPT_EXISTS"
        | "SHOPEE_DELIVERY_UNCERTAIN_REVIEW_REQUIRED"
        | "SHOPEE_CONTROLLED_PUBLICATION_ACTIVATION_CONFLICT";
    };

function metadataObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function deliveryUncertain(metadata: Record<string, unknown>) {
  return (
    metadata.deliveryUncertain === true ||
    metadata.deliveryState === "DELIVERY_UNCERTAIN"
  );
}

export async function activateControlledShopeeTelegramPublication(input: {
  publicationId: string;
  channelId: string;
  now: Date;
  database?: PrismaClient;
}): Promise<ControlledShopeeTelegramActivationResult> {
  const database = input.database ?? prisma;
  const publication = await database.publication.findFirst({
    where: { id: input.publicationId, channelId: input.channelId },
    select: {
      id: true,
      channelId: true,
      status: true,
      marketplaceSnapshot: true,
      externalId: true,
      publishedAt: true,
      metadata: true,
      channel: { select: { type: true } },
      attempts: { select: { status: true } },
    },
  });
  if (!publication) {
    return { ok: false, code: "SHOPEE_CONTROLLED_PUBLICATION_NOT_FOUND" };
  }

  const metadata = metadataObject(publication.metadata);
  if (deliveryUncertain(metadata)) {
    return {
      ok: false,
      code: "SHOPEE_DELIVERY_UNCERTAIN_REVIEW_REQUIRED",
    };
  }
  if (publication.attempts.length > 0) {
    return {
      ok: false,
      code: "SHOPEE_CONTROLLED_PUBLICATION_ATTEMPT_EXISTS",
    };
  }
  if (
    publication.marketplaceSnapshot !== "SHOPEE" ||
    publication.channel.type !== "TELEGRAM" ||
    metadata.publicationMode !== "SHOPEE_CONTROLLED" ||
    publication.externalId !== null ||
    publication.publishedAt !== null
  ) {
    return {
      ok: false,
      code: "SHOPEE_CONTROLLED_PUBLICATION_NOT_ACTIVATABLE",
    };
  }
  if (
    publication.status === "SCHEDULED" &&
    metadata.distributionState === "SCHEDULED"
  ) {
    return {
      ok: true,
      status: "ALREADY_SCHEDULED",
      publicationId: publication.id,
      channelId: publication.channelId,
    };
  }
  if (
    publication.status !== "AWAITING_MANUAL_PUBLICATION" ||
    metadata.distributionState !== "PLANNED"
  ) {
    return {
      ok: false,
      code: "SHOPEE_CONTROLLED_PUBLICATION_NOT_ACTIVATABLE",
    };
  }

  const transition = await database.publication.updateMany({
    where: {
      id: publication.id,
      channelId: input.channelId,
      marketplaceSnapshot: "SHOPEE",
      status: "AWAITING_MANUAL_PUBLICATION",
      externalId: null,
      publishedAt: null,
      metadata: { equals: metadata as Prisma.InputJsonValue },
      channel: { is: { type: "TELEGRAM" } },
      attempts: { none: {} },
    },
    data: {
      status: "SCHEDULED",
      scheduledAt: input.now,
      metadata: {
        ...metadata,
        distributionState: "SCHEDULED",
        autoDistributionActivatedAt: input.now.toISOString(),
      } as Prisma.InputJsonValue,
    },
  });
  if (transition.count !== 1) {
    return {
      ok: false,
      code: "SHOPEE_CONTROLLED_PUBLICATION_ACTIVATION_CONFLICT",
    };
  }
  return {
    ok: true,
    status: "ACTIVATED",
    publicationId: publication.id,
    channelId: publication.channelId,
  };
}
