import { prisma } from "@affiliate/database";
import { AdminShell } from "@/components/admin-shell";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { StatusBadge } from "@/components/ui/status-badge";
import { DataTableContainer } from "@/components/ui/table";
import { acknowledgeAlertAction } from "@/lib/actions";
import { formatDateTime } from "@/lib/format";

export const dynamic = "force-dynamic";

type LogsPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function single(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function LogsPage({ searchParams }: LogsPageProps) {
  const params = await searchParams;
  const severity = single(params?.severity);
  const status = single(params?.status);
  const search = single(params?.search)?.trim().slice(0, 100);
  const alerts = await prisma.systemAlert.findMany({
    where: {
      ...(severity && severity !== "ALL"
        ? { severity: severity as "INFO" | "WARNING" | "ERROR" | "CRITICAL" }
        : {}),
      ...(status === "open" ? { acknowledged: false } : {}),
      ...(status === "acknowledged" ? { acknowledged: true } : {}),
      ...(search
        ? {
            OR: [
              { source: { contains: search, mode: "insensitive" as const } },
              { message: { contains: search, mode: "insensitive" as const } },
            ],
          }
        : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return (
    <AdminShell currentPath="/logs" title="Logs">
      <form
        aria-label="Filtros de logs"
        className="grid gap-3 rounded-[var(--radius-lg)] border bg-[var(--surface)] p-4 shadow-[var(--shadow-sm)] md:grid-cols-[2fr_1fr_1fr_auto]"
      >
        <Input
          name="search"
          type="search"
          defaultValue={search ?? ""}
          placeholder="Buscar por origem ou mensagem"
          aria-label="Buscar logs"
        />
        <Select
          name="severity"
          defaultValue={severity ?? "ALL"}
          aria-label="Severidade"
        >
          <option value="ALL">Todas as severidades</option>
          <option value="INFO">Informativo</option>
          <option value="WARNING">Atenção</option>
          <option value="ERROR">Erro</option>
          <option value="CRITICAL">Crítico</option>
        </Select>
        <Select
          name="status"
          defaultValue={status ?? "all"}
          aria-label="Status"
        >
          <option value="all">Todos os status</option>
          <option value="open">Abertos</option>
          <option value="acknowledged">Reconhecidos</option>
        </Select>
        <Button type="submit">Filtrar</Button>
      </form>

      {alerts.length === 0 ? (
        <EmptyState
          title="Nenhum alerta encontrado"
          description="Alertas reais do worker e do sistema aparecerao aqui."
        />
      ) : (
        <DataTableContainer
          label={`Alertas do sistema: ${alerts.length} resultados`}
        >
          <table className="w-full min-w-[820px] text-left text-sm">
            <thead className="border-b bg-[var(--muted)] text-xs uppercase text-[var(--muted-foreground)]">
              <tr>
                <th className="px-4 py-3">Nível</th>
                <th className="px-4 py-3">Fonte</th>
                <th className="px-4 py-3">Mensagem</th>
                <th className="px-4 py-3">Criado em</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Ação</th>
              </tr>
            </thead>
            <tbody>
              {alerts.map((alert) => (
                <tr key={alert.id} className="border-b last:border-0">
                  <td className="px-4 py-3">
                    <StatusBadge status={alert.severity} />
                  </td>
                  <td className="px-4 py-3">{alert.source}</td>
                  <td className="px-4 py-3">{alert.message}</td>
                  <td className="px-4 py-3">
                    {formatDateTime(alert.createdAt)}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge
                      status={alert.acknowledged ? "SUCCEEDED" : "WARNING"}
                      label={alert.acknowledged ? "Reconhecido" : "Aberto"}
                    />
                  </td>
                  <td className="px-4 py-3">
                    {!alert.acknowledged ? (
                      <form action={acknowledgeAlertAction}>
                        <input type="hidden" name="id" value={alert.id} />
                        <Button variant="outline" type="submit">
                          Reconhecer
                        </Button>
                      </form>
                    ) : (
                      "-"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </DataTableContainer>
      )}
    </AdminShell>
  );
}
