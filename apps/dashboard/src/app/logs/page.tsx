import { AdminShell } from "@/components/admin-shell";
import { EmptyState } from "@/components/empty-state";

export default function LogsPage() {
  return (
    <AdminShell currentPath="/logs" title="Logs">
      <EmptyState
        title="Nenhum alerta registrado"
        description="Alertas reais do sistema aparecerao aqui quando forem persistidos no PostgreSQL."
      />
    </AdminShell>
  );
}
