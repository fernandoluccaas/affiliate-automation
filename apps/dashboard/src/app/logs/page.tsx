import { prisma } from "@affiliate/database";
import { AdminShell } from "@/components/admin-shell";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
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
  const alerts = await prisma.systemAlert.findMany({
    where: {
      ...(severity && severity !== "ALL" ? { severity: severity as "INFO" | "WARNING" | "ERROR" | "CRITICAL" } : {}),
      ...(status === "open" ? { acknowledged: false } : {}),
      ...(status === "acknowledged" ? { acknowledged: true } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return (
    <AdminShell currentPath="/logs" title="Logs">
      <form className="grid gap-3 rounded-md border bg-white p-4 md:grid-cols-[1fr_1fr_auto]">
        <Select name="severity" defaultValue={severity ?? "ALL"} aria-label="Severidade">
          <option value="ALL">Todas severidades</option>
          <option value="INFO">INFO</option>
          <option value="WARNING">WARNING</option>
          <option value="ERROR">ERROR</option>
          <option value="CRITICAL">CRITICAL</option>
        </Select>
        <Select name="status" defaultValue={status ?? "all"} aria-label="Status">
          <option value="all">Todos status</option>
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
        <div className="overflow-x-auto rounded-md border bg-white">
          <table className="w-full min-w-[820px] text-left text-sm">
            <thead className="border-b bg-[var(--muted)] text-xs uppercase text-[var(--muted-foreground)]">
              <tr>
                <th className="px-4 py-3">Nivel</th>
                <th className="px-4 py-3">Fonte</th>
                <th className="px-4 py-3">Mensagem</th>
                <th className="px-4 py-3">Criado em</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Acao</th>
              </tr>
            </thead>
            <tbody>
              {alerts.map((alert) => (
                <tr key={alert.id} className="border-b last:border-0">
                  <td className="px-4 py-3">{alert.severity}</td>
                  <td className="px-4 py-3">{alert.source}</td>
                  <td className="px-4 py-3">{alert.message}</td>
                  <td className="px-4 py-3">{formatDateTime(alert.createdAt)}</td>
                  <td className="px-4 py-3">{alert.acknowledged ? "Reconhecido" : "Aberto"}</td>
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
        </div>
      )}
    </AdminShell>
  );
}
