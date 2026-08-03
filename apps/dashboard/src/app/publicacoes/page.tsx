import { prisma } from "@affiliate/database";
import { AdminShell } from "@/components/admin-shell";
import { EmptyState } from "@/components/empty-state";
import { formatCurrency, formatDateTime, formatPercentage } from "@/lib/format";
import { publicationTitleSnapshot } from "@/lib/publication-snapshot";
import { whatsappWebPublicationView } from "@/lib/whatsapp-web-publication-view";
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
          <table className="w-full min-w-[1540px] text-left text-sm">
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
                <th className="px-4 py-3">Controle Web</th>
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
                const webView = whatsappWebPublicationView(publication);
                const latestAttempt = publication.attempts[0];

                return (
                  <tr key={publication.id} className="border-b last:border-0">
                    <td className="px-4 py-3">
                      <div>{publication.status}</div>
                      {webView ? (
                        <span className="mt-2 inline-flex rounded-full border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] font-semibold text-amber-900">
                          {webView.badge}
                        </span>
                      ) : null}
                    </td>
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
                    <td className="min-w-[360px] px-4 py-3">
                      {webView ? (
                        <details className="rounded border border-amber-200 bg-amber-50/50 p-3">
                          <summary className="cursor-pointer font-medium">
                            {webView.badge}
                          </summary>
                          <dl className="mt-3 grid grid-cols-[140px_1fr] gap-x-2 gap-y-1 text-xs">
                            <dt>Publication ID</dt>
                            <dd className="break-all font-mono">
                              {publication.id}
                            </dd>
                            <dt>Oferta / versão</dt>
                            <dd>
                              {publication.offerId} / v
                              {publication.offerVersionSnapshot}
                            </dd>
                            <dt>Canal / modo</dt>
                            <dd>
                              {publication.channel.type} / WEB_EXPERIMENTAL
                            </dd>
                            <dt>Estado Web</dt>
                            <dd>{webView.state}</dd>
                            <dt>Planejada</dt>
                            <dd>{formatDateTime(webView.plannedAt)}</dd>
                            <dt>Planejador / run</dt>
                            <dd className="break-all">
                              {webView.plannedBy ?? "-"} /{" "}
                              {webView.planningRunId ?? "-"}
                            </dd>
                            <dt>Inspeção visual</dt>
                            <dd>
                              {webView.visualInspectionRequired
                                ? "obrigatória"
                                : "dispensada"}
                              {" / "}
                              {webView.visualInspectionConfirmed
                                ? "confirmada"
                                : "pendente"}
                            </dd>
                            <dt>Preflight</dt>
                            <dd>
                              {webView.preflightRequired
                                ? "obrigatório"
                                : "dispensado"}
                              {" / "}
                              {webView.preflightCompleted
                                ? "concluído"
                                : "pendente"}
                            </dd>
                            <dt>Envio real</dt>
                            <dd>
                              autorizado: {String(webView.realSendAuthorized)}
                              {" / "}elegível:{" "}
                              {String(webView.realSendEligible)}
                            </dd>
                            <dt>Bloqueio</dt>
                            <dd>{webView.dispatchBlockedReason ?? "-"}</dd>
                            <dt>Entrega incerta</dt>
                            <dd>{String(webView.deliveryUncertain)}</dd>
                            <dt>Entrega confirmada</dt>
                            <dd>
                              {formatDateTime(webView.deliveryConfirmedAt)}
                            </dd>
                            <dt>Resolução manual</dt>
                            <dd>
                              {webView.manualDeliveryResolution ?? "-"} /{" "}
                              {formatDateTime(webView.manualDeliveryResolvedAt)}
                            </dd>
                            <dt>Retry autorizado</dt>
                            <dd>{String(webView.retryAuthorized)}</dd>
                            <dt>Stage / causa</dt>
                            <dd>
                              {webView.stage ?? "-"} /{" "}
                              {webView.rootCause ?? "-"}
                            </dd>
                            <dt>Última tentativa</dt>
                            <dd>
                              {latestAttempt
                                ? `${latestAttempt.status} / ${latestAttempt.errorMessage ?? "sem erro"}`
                                : "nenhuma"}
                            </dd>
                            <dt>Preço / link</dt>
                            <dd className="break-all">
                              {formatCurrency(publication.currentPriceSnapshot)}
                              {" / "}
                              {publication.affiliateUrlSnapshot ?? "-"}
                            </dd>
                            <dt>Imagem</dt>
                            <dd className="break-all">
                              {publication.imageUrlSnapshot ?? "-"}
                            </dd>
                          </dl>
                          <div className="mt-3 grid gap-2">
                            <p className="text-xs font-medium">
                              Comandos locais para copiar — não executados pelo
                              dashboard:
                            </p>
                            {webView.commands.map((command) => (
                              <code
                                key={command}
                                className="select-all overflow-x-auto rounded bg-slate-950 p-2 text-[11px] text-slate-50"
                              >
                                {command}
                              </code>
                            ))}
                          </div>
                        </details>
                      ) : (
                        "-"
                      )}
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
