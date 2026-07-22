import { AdminShell } from "@/components/admin-shell";
import { EmptyState } from "@/components/empty-state";

export default function CouponsPage() {
  return (
    <AdminShell currentPath="/cupons" title="Cupons">
      <EmptyState
        title="Nenhuma gestao de cupons ativa"
        description="Cupons informados em ofertas manuais sao armazenados, mas a administracao dedicada ficara para uma fase posterior."
        actionHref="/ofertas/nova"
        actionLabel="Cadastrar oferta com cupom"
      />
    </AdminShell>
  );
}
