import { AdminShell } from "@/components/admin-shell";
import { EmptyState } from "@/components/empty-state";

export default function PublicationsPage() {
  return (
    <AdminShell currentPath="/publicacoes" title="Publicacoes">
      <EmptyState
        title="Nenhuma publicacao agendada"
        description="Ofertas prontas para publicacao aparecem primeiro no pipeline manual antes de qualquer publicador real."
        actionHref="/ofertas"
        actionLabel="Ver ofertas"
      />
    </AdminShell>
  );
}
