import { AdminShell } from "@/components/admin-shell";
import { EmptyState } from "@/components/empty-state";

export default function IntegrationsPage() {
  return (
    <AdminShell currentPath="/integracoes" title="Integracoes">
      <EmptyState
        title="Nenhuma integracao conectada"
        description="Conectores reais de marketplaces, OpenAI e mensageria nao fazem parte da Fase 2A."
      />
    </AdminShell>
  );
}
