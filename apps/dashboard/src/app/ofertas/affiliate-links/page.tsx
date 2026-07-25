import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { prisma } from "@affiliate/database";
import { AdminShell } from "@/components/admin-shell";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatCurrency, formatPercentage } from "@/lib/format";
import { saveMercadoLivreAffiliateUrlAction } from "@/lib/actions";

export const dynamic = "force-dynamic";

type AffiliateLinksPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function messageText(message?: string | string[]) {
  const value = Array.isArray(message) ? message[0] : message;

  if (value === "saved") return "Link oficial associado e oferta validada para publicacao.";
  if (value === "failed") return "Link salvo nao deixou a oferta pronta. Confira os dados da oferta.";
  if (value === "invalid") return "Informe uma URL afiliada valida.";
  if (value === "not-found") return "Oferta Mercado Livre nao encontrada.";
  return null;
}

export default async function AffiliateLinksPage({ searchParams }: AffiliateLinksPageProps) {
  const params = await searchParams;
  const message = messageText(params?.message);
  const offers = await prisma.offer.findMany({
    where: {
      marketplace: "MERCADO_LIVRE",
      status: "READY_FOR_AFFILIATE_LINK",
      affiliateUrl: null,
    },
    orderBy: [{ score: "desc" }, { collectedAt: "desc" }],
    take: 50,
    select: {
      id: true,
      externalProductId: true,
      title: true,
      productUrl: true,
      category: true,
      currentPrice: true,
      discountPercentage: true,
      score: true,
      scoreCompletenessPercentage: true,
      affiliateEligibility: true,
      version: true,
    },
  });

  return (
    <AdminShell currentPath="/ofertas" title="Links afiliados">
      <div className="flex">
        <Button asChild variant="outline">
          <Link href="/ofertas">
            <ArrowLeft aria-hidden="true" size={16} />
            Ofertas
          </Link>
        </Button>
      </div>

      {message ? <div className="rounded-md border bg-white px-4 py-3 text-sm">{message}</div> : null}

      {offers.length === 0 ? (
        <EmptyState
          title="Nenhuma oferta aguardando link"
          description="Ofertas Mercado Livre validas sem affiliateUrl aparecem aqui para associacao manual do link oficial."
        />
      ) : (
        <div className="overflow-x-auto rounded-md border bg-white">
          <table className="w-full min-w-[1120px] border-collapse text-left text-sm">
            <thead className="border-b bg-[var(--muted)] text-xs uppercase text-[var(--muted-foreground)]">
              <tr>
                <th className="px-4 py-3 font-semibold">Produto</th>
                <th className="px-4 py-3 font-semibold">Preco</th>
                <th className="px-4 py-3 font-semibold">Score</th>
                <th className="px-4 py-3 font-semibold">Elegibilidade</th>
                <th className="px-4 py-3 font-semibold">URL original</th>
                <th className="px-4 py-3 font-semibold">Link oficial</th>
              </tr>
            </thead>
            <tbody>
              {offers.map((offer) => (
                <tr key={offer.id} className="border-b align-top last:border-0">
                  <td className="max-w-[280px] px-4 py-3">
                    <div className="font-medium">{offer.title}</div>
                    <div className="mt-1 text-xs text-[var(--muted-foreground)]">
                      {offer.externalProductId} · v{offer.version} · {offer.category ?? "-"}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div>{formatCurrency(offer.currentPrice)}</div>
                    <div className="text-xs text-[var(--muted-foreground)]">
                      desconto {offer.discountPercentage === null ? "-" : `${formatPercentage(offer.discountPercentage)}%`}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {offer.score ?? "-"}
                    <div className="text-xs text-[var(--muted-foreground)]">
                      {offer.scoreCompletenessPercentage === null
                        ? "completude -"
                        : `${formatPercentage(offer.scoreCompletenessPercentage)}% completude`}
                    </div>
                  </td>
                  <td className="px-4 py-3">{offer.affiliateEligibility}</td>
                  <td className="max-w-[240px] px-4 py-3">
                    <a
                      className="text-[var(--primary)] underline-offset-2 hover:underline"
                      href={offer.productUrl}
                      rel="noreferrer"
                      target="_blank"
                    >
                      abrir produto
                    </a>
                  </td>
                  <td className="px-4 py-3">
                    <form action={saveMercadoLivreAffiliateUrlAction} className="grid min-w-[320px] gap-2">
                      <input type="hidden" name="offerId" value={offer.id} />
                      <Input name="affiliateUrl" type="url" placeholder="https://..." required />
                      <Input name="affiliateLabel" placeholder="Etiqueta usada (opcional)" />
                      <Button type="submit">Salvar link</Button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AdminShell>
  );
}
