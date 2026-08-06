import type {
  AttributionMatchQuality,
  AttributionMethod,
  AttributionStatus,
  Marketplace,
  PrismaClient,
} from "@affiliate/database";

export type AttributionCandidate = {
  clickId: string;
  affiliateLinkId: string | null;
  publicationId: string | null;
  offerId: string;
  channelId: string | null;
  createdAt: Date;
  subId?: string | null;
};

export type AttributionDecision = {
  status: AttributionStatus;
  method: AttributionMethod;
  matchQuality: AttributionMatchQuality;
  attributedAt: Date | null;
  attributionWindowHours: number;
  clickId: string | null;
  affiliateLinkId: string | null;
  publicationId: string | null;
  offerId: string | null;
  channelId: string | null;
  metadata: {
    reason: string;
    candidatesConsidered: number;
    explicitClickReferenceUsed: boolean;
    subIdUsed: boolean;
    affiliateLinkUsed: boolean;
    publicationUsed: boolean;
    offerUsed: boolean;
  };
};

export type AttributionInput = {
  occurredAt: Date;
  windowHours: number;
  now?: Date;
  existingStatus?: AttributionStatus | null;
  clickReference?: string | null;
  subId?: string | null;
  affiliateLinkId?: string | null;
  publicationId?: string | null;
  offerId?: string | null;
  candidates: readonly AttributionCandidate[];
};

function unattributed(
  input: AttributionInput,
  status: "UNATTRIBUTED_NO_CLICK" | "UNATTRIBUTED_AMBIGUOUS",
  reason: string,
  candidatesConsidered: number,
): AttributionDecision {
  return {
    status,
    method: "NONE",
    matchQuality: status === "UNATTRIBUTED_AMBIGUOUS" ? "AMBIGUOUS" : "NONE",
    attributedAt: null,
    attributionWindowHours: input.windowHours,
    clickId: null,
    affiliateLinkId: null,
    publicationId: null,
    offerId: input.offerId ?? null,
    channelId: null,
    metadata: {
      reason,
      candidatesConsidered,
      explicitClickReferenceUsed: Boolean(input.clickReference),
      subIdUsed: Boolean(input.subId),
      affiliateLinkUsed: Boolean(input.affiliateLinkId),
      publicationUsed: Boolean(input.publicationId),
      offerUsed: Boolean(input.offerId),
    },
  };
}

function attributed(
  input: AttributionInput,
  candidate: AttributionCandidate,
  method: AttributionMethod,
  status: AttributionStatus,
  quality: AttributionMatchQuality,
  reason: string,
  candidatesConsidered: number,
): AttributionDecision {
  return {
    status,
    method,
    matchQuality: quality,
    attributedAt: input.now ?? new Date(),
    attributionWindowHours: input.windowHours,
    clickId: candidate.clickId,
    affiliateLinkId: candidate.affiliateLinkId,
    publicationId: candidate.publicationId,
    offerId: candidate.offerId,
    channelId: candidate.channelId,
    metadata: {
      reason,
      candidatesConsidered,
      explicitClickReferenceUsed: method === "EXTERNAL_CLICK_ID",
      subIdUsed: method === "SUB_ID",
      affiliateLinkUsed: method === "AFFILIATE_LINK",
      publicationUsed: method === "PUBLICATION",
      offerUsed: method === "OFFER" || method === "LAST_CLICK",
    },
  };
}

function uniqueMatch(
  input: AttributionInput,
  matches: AttributionCandidate[],
  method: AttributionMethod,
  status: AttributionStatus,
  quality: AttributionMatchQuality,
  reason: string,
) {
  if (matches.length > 1) {
    return unattributed(input, "UNATTRIBUTED_AMBIGUOUS", `${reason}_AMBIGUOUS`, matches.length);
  }
  if (matches.length === 1) {
    return attributed(input, matches[0]!, method, status, quality, reason, matches.length);
  }
  return null;
}

export function resolveAttribution(input: AttributionInput): AttributionDecision {
  if (input.existingStatus?.startsWith("ATTRIBUTED_")) {
    return {
      ...unattributed(input, "UNATTRIBUTED_NO_CLICK", "CONVERSION_ALREADY_ATTRIBUTED", 0),
      status: "REJECTED_INVALID_DATA",
    };
  }
  if (!Number.isSafeInteger(input.windowHours) || input.windowHours <= 0) {
    return {
      ...unattributed(input, "UNATTRIBUTED_NO_CLICK", "ATTRIBUTION_WINDOW_INVALID", 0),
      status: "REJECTED_INVALID_DATA",
    };
  }
  const windowStart = new Date(input.occurredAt.getTime() - input.windowHours * 3_600_000);
  const candidates = input.candidates.filter(
    (candidate) => candidate.createdAt >= windowStart && candidate.createdAt <= input.occurredAt,
  );
  const methods: Array<{
    active: boolean;
    method: AttributionMethod;
    status: AttributionStatus;
    quality: AttributionMatchQuality;
    reason: string;
    matches: () => AttributionCandidate[];
  }> = [
    {
      active: Boolean(input.clickReference),
      method: "EXTERNAL_CLICK_ID",
      status: "ATTRIBUTED_EXACT",
      quality: "EXACT",
      reason: "EXPLICIT_CLICK_REFERENCE",
      matches: () => candidates.filter((item) => item.clickId === input.clickReference),
    },
    {
      active: Boolean(input.subId),
      method: "SUB_ID",
      status: "ATTRIBUTED_BY_SUB_ID",
      quality: "DETERMINISTIC",
      reason: "DETERMINISTIC_SUB_ID",
      matches: () => candidates.filter((item) => item.subId === input.subId),
    },
    {
      active: Boolean(input.affiliateLinkId),
      method: "AFFILIATE_LINK",
      status: "ATTRIBUTED_EXACT",
      quality: "EXACT",
      reason: "AFFILIATE_LINK_REFERENCE",
      matches: () => candidates.filter((item) => item.affiliateLinkId === input.affiliateLinkId),
    },
    {
      active: Boolean(input.publicationId),
      method: "PUBLICATION",
      status: "ATTRIBUTED_EXACT",
      quality: "EXACT",
      reason: "PUBLICATION_REFERENCE",
      matches: () => candidates.filter((item) => item.publicationId === input.publicationId),
    },
    {
      active: Boolean(input.offerId),
      method: "OFFER",
      status: "ATTRIBUTED_EXACT",
      quality: "UNIQUE_CANDIDATE",
      reason: "OFFER_UNIQUE_CLICK",
      matches: () => candidates.filter((item) => item.offerId === input.offerId),
    },
  ];
  for (const entry of methods) {
    if (!entry.active) continue;
    const decision = uniqueMatch(
      input,
      entry.matches(),
      entry.method,
      entry.status,
      entry.quality,
      entry.reason,
    );
    if (decision) return decision;
  }
  if (candidates.length === 1) {
    return attributed(
      input,
      candidates[0]!,
      "LAST_CLICK",
      "ATTRIBUTED_LAST_CLICK",
      "UNIQUE_CANDIDATE",
      "UNAMBIGUOUS_LAST_CLICK",
      1,
    );
  }
  if (candidates.length > 1) {
    return unattributed(
      input,
      "UNATTRIBUTED_AMBIGUOUS",
      "MULTIPLE_EQUIVALENT_CLICKS",
      candidates.length,
    );
  }
  return unattributed(input, "UNATTRIBUTED_NO_CLICK", "NO_ELIGIBLE_CLICK", candidates.length);
}

export type AttributionReferences = {
  clickReference?: string | null;
  subId?: string | null;
  affiliateSlug?: string | null;
  publicationReference?: string | null;
  offerReference?: string | null;
};

export async function resolveAttributionWithDatabase(input: {
  database: Pick<PrismaClient, "affiliateLink" | "publication" | "offer" | "click">;
  marketplace: Marketplace;
  occurredAt: Date;
  windowHours: number;
  references: AttributionReferences;
  now?: Date;
}) {
  const windowStart = new Date(input.occurredAt.getTime() - input.windowHours * 3_600_000);
  const affiliateLink = input.references.affiliateSlug
    ? await input.database.affiliateLink.findFirst({
        where: { slug: input.references.affiliateSlug, marketplace: input.marketplace, active: true },
        select: { id: true, offerId: true },
      })
    : null;
  const publication = input.references.publicationReference
    ? await input.database.publication.findFirst({
        where: {
          marketplaceSnapshot: input.marketplace,
          OR: [
            { externalId: input.references.publicationReference },
            { idempotencyKey: input.references.publicationReference },
          ],
        },
        select: { id: true, offerId: true },
      })
    : null;
  const offer = input.references.offerReference
    ? await input.database.offer.findFirst({
        where: { marketplace: input.marketplace, externalProductId: input.references.offerReference },
        orderBy: { version: "desc" },
        select: { id: true },
      })
    : null;
  const subPublications = input.references.subId
    ? await input.database.publication.findMany({
        where: {
          marketplaceSnapshot: input.marketplace,
          metadata: { path: ["attributionSubId"], equals: input.references.subId },
        },
        take: 2,
        select: { id: true },
      })
    : [];
  const or = [
    ...(input.references.clickReference ? [{ id: input.references.clickReference }] : []),
    ...(affiliateLink ? [{ affiliateLinkId: affiliateLink.id }] : []),
    ...(publication ? [{ publicationId: publication.id }] : []),
    ...(offer ? [{ offerId: offer.id }] : []),
    ...(subPublications.length ? [{ publicationId: { in: subPublications.map((item) => item.id) } }] : []),
  ];
  const rows = or.length
    ? await input.database.click.findMany({
        where: {
          marketplace: input.marketplace,
          createdAt: { gte: windowStart, lte: input.occurredAt },
          OR: or,
        },
        orderBy: { createdAt: "desc" },
        take: 25,
        select: {
          id: true,
          affiliateLinkId: true,
          publicationId: true,
          offerId: true,
          channelId: true,
          createdAt: true,
        },
      })
    : [];
  const subPublicationIds = new Set(subPublications.map((item) => item.id));
  const candidates = rows.map((row) => ({
    clickId: row.id,
    affiliateLinkId: row.affiliateLinkId,
    publicationId: row.publicationId,
    offerId: row.offerId,
    channelId: row.channelId,
    createdAt: row.createdAt,
    subId: row.publicationId && subPublicationIds.has(row.publicationId)
      ? input.references.subId ?? null
      : null,
  }));
  const resolvedOfferId = offer?.id ?? publication?.offerId ?? affiliateLink?.offerId;
  return resolveAttribution({
    occurredAt: input.occurredAt,
    windowHours: input.windowHours,
    ...(input.now ? { now: input.now } : {}),
    ...(input.references.clickReference !== undefined
      ? { clickReference: input.references.clickReference }
      : {}),
    ...(input.references.subId !== undefined ? { subId: input.references.subId } : {}),
    ...(affiliateLink ? { affiliateLinkId: affiliateLink.id } : {}),
    ...(publication ? { publicationId: publication.id } : {}),
    ...(resolvedOfferId ? { offerId: resolvedOfferId } : {}),
    candidates,
  });
}
