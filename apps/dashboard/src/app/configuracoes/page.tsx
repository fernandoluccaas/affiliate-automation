import { AdminShell } from "@/components/admin-shell";
import { EmptyState } from "@/components/empty-state";
import { Alert } from "@/components/ui/alert";

export default function SettingsPage() {
  return (
    <AdminShell currentPath="/configuracoes" title="Configurações">
      <Alert tone="info" title="Configuração protegida">
        Variáveis sensíveis são administradas no servidor e nunca são enviadas
        ao navegador.
      </Alert>
      <EmptyState
        title="Nenhuma configuração editável"
        description="Esta área é somente leitura nesta fase. Use as páginas de Canais e Integrações para alterar configurações que possuem fluxo administrativo seguro."
      />
    </AdminShell>
  );
}
