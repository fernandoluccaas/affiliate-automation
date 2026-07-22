import { AdminShell } from "@/components/admin-shell";
import { EmptyState } from "@/components/empty-state";

export default function AutomationsPage() {
  return (
    <AdminShell currentPath="/automacoes" title="Automacoes">
      <EmptyState
        title="Nenhuma automacao em execucao"
        description="A Fase 2A mantem o fluxo manual; execucoes automatizadas dependem de conectores oficiais em fases futuras."
      />
    </AdminShell>
  );
}
