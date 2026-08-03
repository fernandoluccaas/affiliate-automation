import { prisma } from "@affiliate/database";
import { AdminShell } from "@/components/admin-shell";
import { EmptyState } from "@/components/empty-state";
import { formatCurrency, formatDateTime, formatPercentage } from "@/lib/format";
import { publicationTitleSnapshot } from "@/lib/publication-snapshot";
import {
  authorizeWhatsAppWebRetryAction,
  reviewWhatsAppWebDeliveryAction,
} from "@/lib/actions";
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
                const manualNotDelivered =
                  metadata.manualDeliveryResolution ===
                  "MANUALLY_CONFIRMED_NOT_DELIVERED";

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
                          <form
                            action={reviewWhatsAppWebDeliveryAction}
                            className="grid gap-2"
                          >
                            <input
                              type="hidden"
                              name="publicationId"
                              value={publication.id}
                            />
                            <input
                              name="reason"
                              maxLength={500}
                              placeholder="Motivo opcional para auditoria"
                              className="rounded border px-2 py-1"
                            />
                            <label className="flex items-start gap-2">
                              <input
                                type="checkbox"
                                name="confirmed"
                                value="true"
                                required
                              />
                              <span>
                                Revisei visualmente o grupo correto e confirmo
                                esta decisao.
                              </span>
                            </label>
                            <div className="flex flex-wrap gap-2">
                              <Button
                                name="decision"
                                value="DELIVERED"
                                type="submit"
                                variant="outline"
                              >
                                Confirmar como entregue
                              </Button>
                              <Button
                                name="decision"
                                value="NOT_DELIVERED"
                                type="submit"
                                variant="outline"
                              >
                                Confirmar como nao entregue
                              </Button>
                              <Button
                                name="decision"
                                value="KEEP_UNCERTAIN"
                                type="submit"
                                variant="outline"
                              >
                                Manter inconclusiva
                              </Button>
                            </div>
                          </form>
                        </div>
                      ) : manualNotDelivered &&
                        metadata.retryAuthorized !== true ? (
                        <div className="grid gap-2 rounded border border-red-200 bg-red-50 p-3">
                          <p>
                            A entrega foi marcada como nao realizada. Retry
                            continua bloqueado.
                          </p>
                          <form
                            action={authorizeWhatsAppWebRetryAction}
                            className="grid gap-2"
                          >
                            <input
                              type="hidden"
                              name="publicationId"
                              value={publication.id}
                            />
                            <label className="flex items-start gap-2">
                              <input
                                type="checkbox"
                                name="confirmation"
                                value="AUTHORIZE_ONE_WHATSAPP_WEB_RETRY"
                                required
                              />
                              <span>
                                Autorizo explicitamente uma unica nova
                                tentativa.
                              </span>
                            </label>
                            <Button type="submit" variant="outline">
                              Autorizar retry separado
                            </Button>
                          </form>
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
