import {
  getWhatsAppWebQueueStatus,
  prisma,
  type WhatsAppWebQueueItem,
} from "@affiliate/database";
import { AdminShell } from "@/components/admin-shell";
import { EmptyState } from "@/components/empty-state";
import { formatCurrency, formatDateTime, formatPercentage } from "@/lib/format";
import { publicationTitleSnapshot } from "@/lib/publication-snapshot";
import { whatsappWebPublicationView } from "@/lib/whatsapp-web-publication-view";
import {
  archiveWhatsAppWebPublicationAction,
  authorizeWhatsAppWebRetryAction,
  authorizeWhatsAppWebSendAction,
  cancelWhatsAppWebPublicationAction,
  reviewWhatsAppWebDeliveryAction,
  revokeWhatsAppWebSendAuthorizationAction,
} from "@/lib/actions";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

export default async function PublicationsPage() {
  const publications = await prisma.publication.findMany({
    orderBy: { scheduledAt: "desc" },
    take: 50,
    include: {
      channel: true,
      attempts: { orderBy: { attemptedAt: "desc" } },
    },
  });
  const queueItems = new Map<string, WhatsAppWebQueueItem>();
  const webChannelIds = [
    ...new Set(
      publications.flatMap((publication) => {
        const metadata =
          publication.metadata &&
          typeof publication.metadata === "object" &&
          !Array.isArray(publication.metadata)
            ? (publication.metadata as Record<string, unknown>)
            : {};
        return metadata.publicationMode === "WEB_EXPERIMENTAL"
          ? [publication.channelId]
          : [];
      }),
    ),
  ];
  const queueSummaries = new Map(
    (
      await Promise.all(
        webChannelIds.map((channelId) =>
          getWhatsAppWebQueueStatus(prisma, channelId),
        ),
      )
    ).map((queue) => [queue.channelId, queue] as const),
  );
  for (const queue of queueSummaries.values()) {
    for (const item of queue.items) queueItems.set(item.publicationId, item);
  }

  return (
    <AdminShell currentPath="/publicacoes" title="Publicacoes">
      {queueSummaries.size > 0 ? (
        <section className="mb-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {[...queueSummaries.values()].map((queue) => (
            <div key={queue.channelId} className="rounded-md border bg-white p-4">
              <h2 className="font-semibold">Fila operacional WhatsApp Web</h2>
              <dl className="mt-2 grid grid-cols-[130px_1fr] gap-1 text-xs">
                <dt>Próxima</dt>
                <dd className="break-all font-mono">
                  {queue.activePublicationId ?? "nenhuma"}
                </dd>
                <dt>Estado</dt>
                <dd>{queue.activeState ?? "SEM ITEM ATIVO"}</dd>
                <dt>Aguardando</dt>
                <dd>{queue.waitingCount}</dd>
                <dt>Entrega incerta</dt>
                <dd>{queue.deliveryUncertainCount}</dd>
                <dt>Total não terminal</dt>
                <dd>{queue.total}</dd>
              </dl>
            </div>
          ))}
        </section>
      ) : null}
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
                <th className="sticky right-[300px] z-20 bg-[var(--muted)] px-4 py-3">Controle Web</th>
                <th className="sticky right-0 z-20 bg-[var(--muted)] px-4 py-3">Revisao</th>
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
                const webView = whatsappWebPublicationView(
                  publication,
                  queueItems.get(publication.id),
                );
                const latestAttempt = publication.attempts[0];
                const canCancel = Boolean(
                  webView &&
                    !deliveryUncertain &&
                    ![
                      "PUBLISHED",
                      "CANCELLED",
                      "ARCHIVED",
                      "SEND_IN_PROGRESS",
                    ].includes(webView.storedState),
                );
                const canArchive = Boolean(
                  webView &&
                    !deliveryUncertain &&
                    ["PUBLISHED", "CANCELLED"].includes(webView.storedState),
                );
                const canAuthorize = Boolean(
                  webView?.active &&
                    ["PREFLIGHT_READY", "AUTHORIZATION_EXPIRED"].includes(
                      webView.storedState,
                    ),
                );
                const canRevoke = webView?.authorizationStatus === "ACTIVE";

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
                    <td className="sticky right-[300px] z-10 min-w-[360px] border-l bg-white px-4 py-3 align-top">
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
                            <dd>
                              {webView.state} (persistido: {webView.storedState})
                            </dd>
                            <dt>Fila</dt>
                            <dd>
                              {webView.active
                                ? "próxima Publication ativa"
                                : `posição ${webView.queuePosition ?? "-"}`}
                              {webView.blockingPublicationId
                                ? ` / aguarda ${webView.blockingPublicationId}`
                                : ""}
                            </dd>
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
                              {webView.visualInspectionAt
                                ? ` / ${formatDateTime(webView.visualInspectionAt)}`
                                : ""}
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
                              {webView.preflightAt
                                ? ` / ${formatDateTime(webView.preflightAt)}`
                                : ""}
                            </dd>
                            <dt>Autorização</dt>
                            <dd>
                              {webView.authorizationStatus ?? "ausente"} / expira{" "}
                              {formatDateTime(webView.authorizationExpiresAt)} / fp{" "}
                              {webView.authorizationFingerprint?.slice(0, 12) ?? "-"}
                            </dd>
                            <dt>Claim</dt>
                            <dd>
                              {webView.authorizationClaimId ?? "-"} /{" "}
                              {formatDateTime(webView.authorizationClaimedAt)}
                            </dd>
                            <dt>Autorizacao consumida</dt>
                            <dd>
                              {formatDateTime(webView.authorizationConsumedAt)}
                            </dd>
                            <dt>Marcador de clique</dt>
                            <dd>
                              inicio {formatDateTime(webView.sendClickStartedAt)} /{" "}
                              clicado {String(webView.sendWasClicked)} /{" "}
                              {formatDateTime(webView.sendClickedAt)}
                            </dd>
                            <dt>Envio real</dt>
                            <dd>
                              autorizado: {String(webView.realSendAuthorized)}
                              {" / "}elegível:{" "}
                              {String(webView.realSendEligible)}
                            </dd>
                            <dt>Bloqueio</dt>
                            <dd>{webView.dispatchBlockedReason ?? "-"}</dd>
                            <dt>Proxima acao humana</dt>
                            <dd>{webView.nextHumanAction}</dd>
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
                          {webView.transitionHistory.length > 0 ? (
                            <div className="mt-3 rounded border bg-white p-2 text-xs">
                              <p className="font-medium">Histórico de transições</p>
                              <ol className="mt-1 grid gap-1">
                                {webView.transitionHistory.map((entry, index) => (
                                  <li key={`${entry.at}-${index}`}>
                                    {entry.from} → {entry.to} /{" "}
                                    {formatDateTime(entry.at)} / ator {entry.by}
                                    {entry.reason ? ` / ${entry.reason}` : ""}
                                  </li>
                                ))}
                              </ol>
                            </div>
                          ) : null}
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
                          <div className="mt-4 grid gap-3 border-t border-amber-200 pt-3">
                            <p className="text-xs font-medium">
                              Ações de controle — nunca abrem o navegador
                            </p>
                            {canAuthorize ? (
                              <form
                                action={authorizeWhatsAppWebSendAction}
                                className="grid gap-2 rounded border bg-white p-2 text-xs"
                              >
                                <input
                                  type="hidden"
                                  name="publicationId"
                                  value={publication.id}
                                />
                                <input
                                  type="hidden"
                                  name="expiresInMinutes"
                                  value="15"
                                />
                                <label className="flex items-start gap-2">
                                  <input
                                    type="checkbox"
                                    name="confirmation"
                                    value="AUTHORIZE_ONE_WHATSAPP_WEB_SEND"
                                    required
                                  />
                                  <span>
                                    Autorizo somente esta Publication por 15
                                    minutos.
                                  </span>
                                </label>
                                <Button type="submit" variant="outline">
                                  Autorizar uma publicação
                                </Button>
                              </form>
                            ) : null}
                            {canRevoke ? (
                              <form
                                action={revokeWhatsAppWebSendAuthorizationAction}
                                className="grid gap-2 rounded border bg-white p-2 text-xs"
                              >
                                <input
                                  type="hidden"
                                  name="publicationId"
                                  value={publication.id}
                                />
                                <input
                                  name="reason"
                                  required
                                  maxLength={500}
                                  placeholder="Motivo da revogação"
                                  className="rounded border px-2 py-1"
                                />
                                <label className="flex gap-2">
                                  <input
                                    type="checkbox"
                                    name="confirmed"
                                    value="true"
                                    required
                                  />
                                  Confirmo a revogação.
                                </label>
                                <Button type="submit" variant="outline">
                                  Revogar autorização
                                </Button>
                              </form>
                            ) : null}
                            {canCancel ? (
                              <form
                                action={cancelWhatsAppWebPublicationAction}
                                className="grid gap-2 rounded border bg-white p-2 text-xs"
                              >
                                <input
                                  type="hidden"
                                  name="publicationId"
                                  value={publication.id}
                                />
                                <input
                                  name="reason"
                                  required
                                  maxLength={500}
                                  placeholder="Motivo do cancelamento"
                                  className="rounded border px-2 py-1"
                                />
                                <label className="flex gap-2">
                                  <input
                                    type="checkbox"
                                    name="confirmed"
                                    value="true"
                                    required
                                  />
                                  Confirmo o cancelamento sem envio.
                                </label>
                                <Button type="submit" variant="outline">
                                  Cancelar Publication
                                </Button>
                              </form>
                            ) : null}
                            {canArchive ? (
                              <form
                                action={archiveWhatsAppWebPublicationAction}
                                className="grid gap-2 rounded border bg-white p-2 text-xs"
                              >
                                <input
                                  type="hidden"
                                  name="publicationId"
                                  value={publication.id}
                                />
                                <input
                                  name="reason"
                                  required
                                  maxLength={500}
                                  placeholder="Motivo do arquivamento"
                                  className="rounded border px-2 py-1"
                                />
                                <label className="flex gap-2">
                                  <input
                                    type="checkbox"
                                    name="confirmed"
                                    value="true"
                                    required
                                  />
                                  Confirmo o arquivamento auditável.
                                </label>
                                <Button type="submit" variant="outline">
                                  Arquivar Publication
                                </Button>
                              </form>
                            ) : null}
                          </div>
                        </details>
                      ) : (
                        "-"
                      )}
                    </td>
                    <td className="sticky right-0 z-10 min-w-[300px] border-l bg-white px-4 py-3 align-top">
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
