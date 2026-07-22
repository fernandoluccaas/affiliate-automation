import { AdminShell } from "@/components/admin-shell";
import { EmptyState } from "@/components/empty-state";

export default function SettingsPage() {
  return (
    <AdminShell currentPath="/configuracoes" title="Configuracoes">
      <EmptyState
        title="Nenhuma configuracao editavel"
        description="Configuracoes sensiveis permanecem no servidor por variaveis de ambiente e nao sao expostas no cliente."
      />
    </AdminShell>
  );
}
