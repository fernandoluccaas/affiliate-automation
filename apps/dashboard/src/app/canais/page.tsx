import { AdminShell } from "@/components/admin-shell";
import { EmptyState } from "@/components/empty-state";

export default function ChannelsPage() {
  return (
    <AdminShell currentPath="/canais" title="Canais">
      <EmptyState
        title="Nenhum canal configurado"
        description="Os canais oficiais serao configurados sem automacao de login, scraping ou WhatsApp Web."
      />
    </AdminShell>
  );
}
