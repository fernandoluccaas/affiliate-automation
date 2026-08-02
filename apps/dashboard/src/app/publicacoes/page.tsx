import { prisma } from "@affiliate/database";
import { AdminShell } from "@/components/admin-shell";
import { EmptyState } from "@/components/empty-state";
import { formatCurrency, formatDateTime, formatPercentage } from "@/lib/format";
import { publicationTitleSnapshot } from "@/lib/publication-snapshot";
import { reviewWhatsAppWebDeliveryAction } from "@/lib/actions";
import { Button } from "@/components/ui/button";

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
                <th className="px-4 py-3">Revisao</th>
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
                const message =
                  typeof payload.message === "string" ? payload.message : "";
                const metadata =
                  publication.metadata &&
                  typeof publication.metadata === "object" &&
                  !Array.isArray(publication.metadata)
                    ? (publication.metadata as Record<string, unknown>)
                    : {};
                const deliveryUncertain = metadata.deliveryUncertain === true;

                return (
                  <tr key={publication.id} className="border-b last:border-0">
                    <td className="px-4 py-3">{publication.status}</td>
                    <td className="max-w-[260px] px-4 py-3">
                      <div className="font-medium">
                        {publicationTitleSnapshot(publication)}
                      </div>
                      <div className="mt-1 text-xs text-[var(--muted-foreground)]">
                        {publication.marketplaceSnapshot} -{" "}
                        {publication.productExternalIdSnapshot}
                        {publication.categorySnapshot
                          ? ` - ${publication.categorySnapshot}`
                          : ""}
                      </div>
                      <div className="mt-1 text-xs text-[var(--muted-foreground)]">
                        {publication.trackingUrlSnapshot}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      v{publication.offerVersionSnapshot}
                    </td>
                    <td className="px-4 py-3">
                      <div>
                        {formatCurrency(publication.currentPriceSnapshot)}
                      </div>
                      <div className="text-xs text-[var(--muted-foreground)]">
                        {publication.originalPriceSnapshot
                          ? `De ${formatCurrency(publication.originalPriceSnapshot)}`
                          : "Preco original indisponivel"}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {publication.discountPercentageSnapshot === null
                        ? "-"
                        : `${formatPercentage(publication.discountPercentageSnapshot)}%`}
                    </td>
                    <td className="px-4 py-3">
                      {publication.couponCodeSnapshot ?? "-"}
                      {publication.couponExpirationSnapshot ? (
                        <div className="text-xs text-[var(--muted-foreground)]">
                          ate{" "}
                          {formatDateTime(publication.couponExpirationSnapshot)}
                        </div>
                      ) : null}
                      {publication.freeShippingSnapshot ? (
                        <div className="text-xs text-[var(--muted-foreground)]">
                          Frete gratis
                        </div>
                      ) : (
                        <div className="text-xs text-[var(--muted-foreground)]">
                          Frete {publication.shippingStatusSnapshot}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {publication.channel.name} ({publication.channel.type})
                    </td>
                    <td className="max-w-[280px] whitespace-pre-wrap px-4 py-3 text-xs">
                      {message || "-"}
                    </td>
                    <td className="px-4 py-3">
                      {formatDateTime(publication.scheduledAt)}
                    </td>
                    <td className="px-4 py-3">
                      {formatDateTime(publication.publishedAt)}
                    </td>
                    <td className="px-4 py-3">{publication.attempts.length}</td>
                    <td className="px-4 py-3">
                      {publication.errorMessage ?? "-"}
                    </td>
                    <td className="px-4 py-3">
                      {publication.externalId ?? "-"}
                    </td>
                    <td className="min-w-[300px] px-4 py-3">
                      {deliveryUncertain ? (
                        <div className="grid gap-2 rounded border border-amber-300 bg-amber-50 p-3">
                          <p>
                            E possivel que a mensagem tenha sido enviada.
                            Verifique o grupo antes de tomar qualquer acao.
                          </p>
                          <div className="flex flex-wrap gap-2">
                            {[
                              ["DELIVERED", "Marcar como entregue"],
                              ["NOT_DELIVERED", "Marcar como nao entregue"],
                              ["CANCEL_RETRY", "Cancelar nova tentativa"],
                              ["AUTHORIZE_RETRY", "Autorizar nova tentativa"],
                            ].map(([decision, label]) => (
                              <form
                                action={reviewWhatsAppWebDeliveryAction}
                                key={decision}
                              >
                                <input
                                  type="hidden"
                                  name="publicationId"
                                  value={publication.id}
                                />
                                <input
                                  type="hidden"
                                  name="decision"
                                  value={decision}
                                />
                                <Button type="submit" variant="outline">
                                  {label}
                                </Button>
                              </form>
                            ))}
                          </div>
                        </div>
                      ) : (
                        "-"
                      )}
                    </td>
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
