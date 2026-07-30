import { prisma } from "@affiliate/database";
import { AdminShell } from "@/components/admin-shell";
import { EmptyState } from "@/components/empty-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { updateWorkerPauseAction } from "@/lib/actions";
import { formatDateTime } from "@/lib/format";
import {
  WORKER_CONTROLS_KEY,
  WORKER_STATUS_KEY,
  workerControlsFromValue,
  workerStatusFromValue,
} from "@/lib/worker-operations";

export const dynamic = "force-dynamic";

function duration(startedAt: Date, finishedAt: Date | null) {
  if (!finishedAt) {
    return "-";
  }

  return `${Math.max(0, finishedAt.getTime() - startedAt.getTime())} ms`;
}

export default async function AutomationsPage() {
  const now = new Date();
  const [
    runs,
    ollamaGenerated,
    openAiGenerated,
    deterministicFallback,
    aiDuration,
    settings,
    mercadoLivreConfig,
    lastPublication,
    readyOffers,
    scheduledPublications,
    recentFailures,
  ] = await Promise.all([
    prisma.automationRun.findMany({
      orderBy: { startedAt: "desc" },
      take: 50,
    }),
    prisma.publication.count({
      where: { aiProvider: "OLLAMA", messageSource: "AI_GENERATED" },
    }),
    prisma.publication.count({
      where: { aiProvider: "OPENAI", messageSource: "AI_GENERATED" },
    }),
    prisma.publication.count({
      where: { messageSource: "DETERMINISTIC_FALLBACK" },
    }),
    prisma.publication.aggregate({
      where: { aiGenerationDurationMs: { not: null } },
      _avg: { aiGenerationDurationMs: true },
    }),
    prisma.systemSetting.findMany({
      where: { key: { in: [WORKER_STATUS_KEY, WORKER_CONTROLS_KEY] } },
      select: { key: true, value: true },
    }),
    prisma.mercadoLivreDiscoveryConfig.findFirst({
      orderBy: { updatedAt: "desc" },
      select: { lastRunAt: true },
    }),
    prisma.publication.findFirst({
      where: { status: "PUBLISHED" },
      orderBy: { publishedAt: "desc" },
      select: { publishedAt: true },
    }),
    prisma.offer.count({ where: { status: "READY_TO_PUBLISH" } }),
    prisma.publication.count({ where: { status: "SCHEDULED" } }),
    prisma.publication.count({
      where: {
        status: { in: ["FAILED", "PUBLICATION_FAILED"] },
        updatedAt: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) },
      },
    }),
  ]);
  const status = workerStatusFromValue(
    settings.find((setting) => setting.key === WORKER_STATUS_KEY)?.value,
    now,
  );
  const controls = workerControlsFromValue(
    settings.find((setting) => setting.key === WORKER_CONTROLS_KEY)?.value,
  );
  const aiGenerated = ollamaGenerated + openAiGenerated;
  const totalGeneratedMessages = aiGenerated + deterministicFallback;
  const fallbackRate =
    totalGeneratedMessages > 0
      ? `${Math.round((deterministicFallback / totalGeneratedMessages) * 100)}%`
      : "-";

  return (
    <AdminShell currentPath="/automacoes" title="Automacoes">
      <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Worker</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold">{status.state}</div>
            <p className="text-xs text-[var(--muted-foreground)]">
              Heartbeat:{" "}
              {status.heartbeatAt
                ? formatDateTime(new Date(status.heartbeatAt))
                : "-"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Mercado Livre</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-sm font-semibold">
              {controls.discoveryPaused ? "PAUSADO" : "ATIVO"}
            </div>
            <p className="text-xs text-[var(--muted-foreground)]">
              Última sincronização:{" "}
              {mercadoLivreConfig?.lastRunAt
                ? formatDateTime(mercadoLivreConfig.lastRunAt)
                : "-"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Telegram</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-sm font-semibold">
              {controls.publicationPaused ? "PAUSADO" : "ATIVO"}
            </div>
            <p className="text-xs text-[var(--muted-foreground)]">
              Última publicação:{" "}
              {lastPublication?.publishedAt
                ? formatDateTime(lastPublication.publishedAt)
                : "-"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">READY_TO_PUBLISH</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold">{readyOffers}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Agendadas</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold">
              {scheduledPublications}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Falhas 24h</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold">{recentFailures}</div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Controles operacionais</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          <form action={updateWorkerPauseAction}>
            <input type="hidden" name="scope" value="discovery" />
            <input
              type="hidden"
              name="paused"
              value={String(!controls.discoveryPaused)}
            />
            <Button type="submit" variant="outline">
              {controls.discoveryPaused
                ? "Retomar discovery"
                : "Pausar discovery"}
            </Button>
          </form>
          <form action={updateWorkerPauseAction}>
            <input type="hidden" name="scope" value="publication" />
            <input
              type="hidden"
              name="paused"
              value={String(!controls.publicationPaused)}
            />
            <Button type="submit" variant="outline">
              {controls.publicationPaused
                ? "Retomar publicações"
                : "Pausar publicações"}
            </Button>
          </form>
          <div className="text-xs text-[var(--muted-foreground)]">
            Próximo discovery:{" "}
            {status.nextDiscovery
              ? formatDateTime(new Date(status.nextDiscovery))
              : "-"}
            {" · "}Próxima publicação:{" "}
            {status.nextPublication
              ? formatDateTime(new Date(status.nextPublication))
              : "-"}
            {status.lastErrorComponent
              ? ` · Último erro: ${status.lastErrorComponent}`
              : ""}
          </div>
          <div className="w-full text-xs text-[var(--muted-foreground)]">
            Discovery: {status.metrics.discoveryRuns} execuções /{" "}
            {status.metrics.discoveryFailed} falhas · Ofertas descobertas:{" "}
            {status.metrics.offersDiscovered} · Links gerados/reutilizados:{" "}
            {status.metrics.affiliateLinksGenerated}/
            {status.metrics.affiliateLinksReused} · Ofertas avaliadas/agendadas:{" "}
            {status.metrics.offersEvaluated}/{status.metrics.offersScheduled} ·
            Publicações concluídas/falhas/retries:{" "}
            {status.metrics.publicationsSucceeded}/
            {status.metrics.publicationsFailed}/
            {status.metrics.publicationsRetried} · IA/fallback:{" "}
            {status.metrics.aiGenerated}/{status.metrics.aiFallbackUsed}
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-5">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Copies Ollama</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold">{ollamaGenerated}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Copies OpenAI</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold">{openAiGenerated}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Fallbacks</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold">
              {deterministicFallback}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Taxa fallback</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold">{fallbackRate}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Tempo medio IA</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold">
              {aiDuration._avg.aiGenerationDurationMs
                ? `${Math.round(aiDuration._avg.aiGenerationDurationMs)} ms`
                : "-"}
            </div>
          </CardContent>
        </Card>
      </div>

      {runs.length === 0 ? (
        <EmptyState
          title="Nenhuma automacao executada"
          description="As execucoes do worker serao registradas aqui como AutomationRun."
        />
      ) : (
        <div className="overflow-x-auto rounded-md border bg-white">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="border-b bg-[var(--muted)] text-xs uppercase text-[var(--muted-foreground)]">
              <tr>
                <th className="px-4 py-3">Nome</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Inicio</th>
                <th className="px-4 py-3">Duracao</th>
                <th className="px-4 py-3">Resultado</th>
                <th className="px-4 py-3">Erro</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id} className="border-b last:border-0">
                  <td className="px-4 py-3">{run.name}</td>
                  <td className="px-4 py-3">{run.status}</td>
                  <td className="px-4 py-3">{formatDateTime(run.startedAt)}</td>
                  <td className="px-4 py-3">
                    {duration(run.startedAt, run.finishedAt)}
                  </td>
                  <td className="max-w-[260px] px-4 py-3 text-xs">
                    <pre className="whitespace-pre-wrap font-sans">
                      {run.metrics ? JSON.stringify(run.metrics, null, 2) : "-"}
                    </pre>
                  </td>
                  <td className="px-4 py-3">{run.errorMessage ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AdminShell>
  );
}
