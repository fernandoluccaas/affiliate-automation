import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@affiliate/database";
import { acquireLock } from "@affiliate/redis";

type RouteContext = {
  params: Promise<{ slug: string }>;
};

function clientFingerprint(request: NextRequest) {
  const userAgent = request.headers.get("user-agent") ?? "";
  const referer = request.headers.get("referer") ?? "";
  return createHash("sha256").update(`${userAgent}:${referer}`).digest("hex").slice(0, 24);
}

async function findPublicationForOffer(offerId: string) {
  return prisma.publication.findFirst({
    where: {
      offerId,
      status: { in: ["PUBLISHED", "EXPORTED", "SCHEDULED"] },
    },
    orderBy: [{ publishedAt: "desc" }, { scheduledAt: "desc" }],
    select: { id: true, channelId: true },
  });
}

export async function GET(request: NextRequest, context: RouteContext) {
  const { slug } = await context.params;
  const affiliateLink = await prisma.affiliateLink.findUnique({
    where: { slug },
    include: {
      offer: {
        include: { product: true },
      },
    },
  });

  if (!affiliateLink?.active) {
    return new NextResponse("Link de afiliado nao encontrado ou inativo.", { status: 404 });
  }

  const destination = affiliateLink.destination || affiliateLink.offer.affiliateUrl || affiliateLink.offer.productUrl;

  try {
    const lock = await acquireLock(`click:${slug}:${clientFingerprint(request)}`, 2000);

    if (lock.acquired) {
      try {
        const publication = await findPublicationForOffer(affiliateLink.offerId);
        await prisma.click.create({
          data: {
            affiliateLinkId: affiliateLink.id,
            offerId: affiliateLink.offerId,
            publicationId: publication?.id ?? null,
            channelId: publication?.channelId ?? null,
            marketplace: affiliateLink.marketplace,
            referer: request.headers.get("referer"),
            userAgent: request.headers.get("user-agent"),
          },
        });
      } finally {
        await lock.release();
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Click tracking failed.");
  }

  return NextResponse.redirect(destination, 302);
}
