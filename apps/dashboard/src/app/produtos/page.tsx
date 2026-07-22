import { AdminShell } from "@/components/admin-shell";
import { EmptyState } from "@/components/empty-state";

export default function ProductsPage() {
  return (
    <AdminShell currentPath="/produtos" title="Produtos">
      <EmptyState
        title="Produtos serao exibidos apos ingestao"
        description="Esta area ainda nao possui uma visao completa. Os produtos sao criados a partir das ofertas cadastradas."
        actionHref="/ofertas/nova"
        actionLabel="Cadastrar oferta"
      />
    </AdminShell>
  );
}
