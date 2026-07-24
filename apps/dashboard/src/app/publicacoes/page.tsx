import { prisma } from "@affiliate/database";
import { AdminShell } from "@/components/admin-shell";
import { EmptyState } from "@/components/empty-state";
import { formatCurrency, formatDateTime, formatPercentage } from "@/lib/format";
import { publicationTitleSnapshot } from "@/lib/publication-snapshot";

export const dynamic = "force-dynamic";

export default async function PublicationsPage() {
  const publications = await prisma.publication.findMany({
    orderBy: { scheduledAt: "desc" },
    take: 50,
    include: {
      channel: { select: { name: true, type: true } },
      attempts: { orderBy: { attemptedAt: "desc" } },
    },
  });

  return (
    <AdminShell currentPath="/publicacoes" title="Publicacoes">
      {publications.length === 0 ? (
        <EmptyState
          title="Nenhuma publicacao encontrada"
          description="Quando o worker agendar uma oferta pronta, ela aparecera nesta lista."
          actionHref="/ofertas"
          actionLabel="Ver ofertas"
        />
      ) : (
        <div className="overflow-x-auto rounded-md border bg-white">
          <table className="w-full min-w-[1320px] text-left text-sm">
            <thead className="border-b bg-[var(--muted)] text-xs uppercase text-[var(--muted-foreground)]">
              <tr>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Oferta publicada</th>
                <th className="px-4 py-3">Versao</th>
                <th className="px-4 py-3">Precos publicados</th>
                <th className="px-4 py-3">Desconto</th>
                <th className="px-4 py-3">Cupom</th>
                <th className="px-4 py-3">Canal</th>
                <th className="px-4 py-3">Mensagem</th>
                <th className="px-4 py-3">Agendada</th>
                <th className="px-4 py-3">Publicada</th>
                <th className="px-4 py-3">Tentativas</th>
                <th className="px-4 py-3">Erro</th>
                <th className="px-4 py-3">ID externo</th>
              </tr>
            </thead>
            <tbody>
              {publications.map((publication) => {
                const payload =
                  publication.messagePayload &&
                  typeof publication.messagePayload === "object" &&
                  !Array.isArray(publication.messagePayload)
                    ? (publication.messagePayload as Record<string, unknown>)
                    : {};
                const message = typeof payload.message === "string" ? payload.message : "";

                return (
                  <tr key={publication.id} className="border-b last:border-0">
                    <td className="px-4 py-3">{publication.status}</td>
                    <td className="max-w-[260px] px-4 py-3">
                      <div className="font-medium">{publicationTitleSnapshot(publication)}</div>
                      <div className="mt-1 text-xs text-[var(--muted-foreground)]">
                        {publication.marketplaceSnapshot} - {publication.productExternalIdSnapshot}
                        {publication.categorySnapshot ? ` - ${publication.categorySnapshot}` : ""}
                      </div>
                      <div className="mt-1 text-xs text-[var(--muted-foreground)]">
                        {publication.trackingUrlSnapshot}
                      </div>
                    </td>
                    <td className="px-4 py-3">v{publication.offerVersionSnapshot}</td>
                    <td className="px-4 py-3">
                      <div>{formatCurrency(publication.currentPriceSnapshot)}</div>
                      <div className="text-xs text-[var(--muted-foreground)]">
                        De {formatCurrency(publication.originalPriceSnapshot)}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {formatPercentage(publication.discountPercentageSnapshot)}%
                    </td>
                    <td className="px-4 py-3">
                      {publication.couponCodeSnapshot ?? "-"}
                      {publication.couponExpirationSnapshot ? (
                        <div className="text-xs text-[var(--muted-foreground)]">
                          ate {formatDateTime(publication.couponExpirationSnapshot)}
                        </div>
                      ) : null}
                      {publication.freeShippingSnapshot ? (
                        <div className="text-xs text-[var(--muted-foreground)]">Frete gratis</div>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">
                      {publication.channel.name} ({publication.channel.type})
                    </td>
                    <td className="max-w-[280px] whitespace-pre-wrap px-4 py-3 text-xs">
                      {message || "-"}
                    </td>
                    <td className="px-4 py-3">{formatDateTime(publication.scheduledAt)}</td>
                    <td className="px-4 py-3">{formatDateTime(publication.publishedAt)}</td>
                    <td className="px-4 py-3">{publication.attempts.length}</td>
                    <td className="px-4 py-3">{publication.errorMessage ?? "-"}</td>
                    <td className="px-4 py-3">{publication.externalId ?? "-"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </AdminShell>
  );
}
