import { prisma } from "@affiliate/database";
import { AdminShell } from "@/components/admin-shell";
import { EmptyState } from "@/components/empty-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateTime } from "@/lib/format";

export const dynamic = "force-dynamic";

function duration(startedAt: Date, finishedAt: Date | null) {
  if (!finishedAt) {
    return "-";
  }

  return `${Math.max(0, finishedAt.getTime() - startedAt.getTime())} ms`;
}

export default async function AutomationsPage() {
  const [runs, ollamaGenerated, openAiGenerated, deterministicFallback, aiDuration] = await Promise.all([
    prisma.automationRun.findMany({
      orderBy: { startedAt: "desc" },
      take: 50,
    }),
    prisma.publication.count({ where: { aiProvider: "OLLAMA", messageSource: "AI_GENERATED" } }),
    prisma.publication.count({ where: { aiProvider: "OPENAI", messageSource: "AI_GENERATED" } }),
    prisma.publication.count({ where: { messageSource: "DETERMINISTIC_FALLBACK" } }),
    prisma.publication.aggregate({
      where: { aiGenerationDurationMs: { not: null } },
      _avg: { aiGenerationDurationMs: true },
    }),
  ]);
  const aiGenerated = ollamaGenerated + openAiGenerated;
  const totalGeneratedMessages = aiGenerated + deterministicFallback;
  const fallbackRate =
    totalGeneratedMessages > 0
      ? `${Math.round((deterministicFallback / totalGeneratedMessages) * 100)}%`
      : "-";

  return (
    <AdminShell currentPath="/automacoes" title="Automacoes">
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
            <div className="text-2xl font-semibold">{deterministicFallback}</div>
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
                  <td className="px-4 py-3">{duration(run.startedAt, run.finishedAt)}</td>
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
