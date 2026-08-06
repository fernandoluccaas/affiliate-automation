import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { prisma } from "@affiliate/database";
import { AdminShell } from "@/components/admin-shell";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { AffiliateLinkBatch } from "./affiliate-link-batch";

export const dynamic = "force-dynamic";

export default async function AffiliateLinksPage() {
  const products = await prisma.product.findMany({
    where: {
      marketplace: "MERCADO_LIVRE",
      offers: {
        some: {
          status: "READY_FOR_AFFILIATE_LINK",
          affiliateUrl: null,
        },
      },
    },
    orderBy: { updatedAt: "desc" },
    take: 200,
    select: {
      offers: {
        orderBy: { version: "desc" },
        take: 1,
        select: {
          id: true,
          externalProductId: true,
          title: true,
          marketplace: true,
          currentPrice: true,
          productUrl: true,
          status: true,
        },
      },
    },
  });
  const offers = products
    .flatMap((product) => product.offers)
    .filter((offer) => offer.status === "READY_FOR_AFFILIATE_LINK")
    .map((offer) => ({
      ...offer,
      currentPrice: offer.currentPrice.toString(),
    }));

  return (
    <AdminShell currentPath="/ofertas" title="Links de afiliado">
      <div className="flex items-center justify-between gap-3">
        <Button asChild variant="outline">
          <Link href="/ofertas">
            <ArrowLeft aria-hidden="true" size={16} />
            Ofertas
          </Link>
        </Button>
        <span className="text-sm text-[var(--muted-foreground)]">
          {offers.length} oferta(s) aguardando link
        </span>
      </div>

      <Alert tone="info" title="Links gerados no Portal oficial">
        <p>
          O sistema mantém a URL original separada e nunca a usa como link de
          afiliado. Gere o link no Portal do Mercado Livre e use um dos três
          métodos abaixo. Toda alteração passa pelo versionamento, validação e
          score normais.
        </p>
      </Alert>

      {offers.length === 0 ? (
        <EmptyState
          title="Nenhuma oferta aguardando link"
          description="Você ainda pode importar um produto novo pelo método B ou C usando productUrl e affiliateUrl."
        />
      ) : null}

      <AffiliateLinkBatch offers={offers} />
    </AdminShell>
  );
}
