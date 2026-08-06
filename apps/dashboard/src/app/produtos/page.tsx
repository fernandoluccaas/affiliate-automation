import { prisma, type Marketplace } from "@affiliate/database";
import { ExternalLink } from "lucide-react";
import { AdminShell } from "@/components/admin-shell";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { StatusBadge } from "@/components/ui/status-badge";
import { DataTableContainer } from "@/components/ui/table";
import { formatDateTime } from "@/lib/format";

export const dynamic = "force-dynamic";

type ProductsPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};
const single = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value;

export default async function ProductsPage({
  searchParams,
}: ProductsPageProps) {
  const params = await searchParams;
  const search = single(params?.search)?.trim().slice(0, 100);
  const marketplaceValue = single(params?.marketplace);
  const marketplace = ["MERCADO_LIVRE", "SHOPEE"].includes(
    marketplaceValue ?? "",
  )
    ? (marketplaceValue as Marketplace)
    : undefined;
  const products = await prisma.product.findMany({
    where: {
      ...(marketplace ? { marketplace } : {}),
      ...(search
        ? {
            OR: [
              { title: { contains: search, mode: "insensitive" as const } },
              {
                externalProductId: {
                  contains: search,
                  mode: "insensitive" as const,
                },
              },
              { category: { contains: search, mode: "insensitive" as const } },
            ],
          }
        : {}),
    },
    orderBy: { updatedAt: "desc" },
    take: 100,
    include: { _count: { select: { offers: true } } },
  });

  return (
    <AdminShell currentPath="/produtos" title="Produtos">
      <form
        aria-label="Filtros de produtos"
        className="grid gap-3 rounded-[var(--radius-lg)] border bg-[var(--surface)] p-4 shadow-[var(--shadow-sm)] sm:grid-cols-[2fr_1fr_auto]"
      >
        <Input
          name="search"
          type="search"
          defaultValue={search ?? ""}
          placeholder="Buscar título, categoria ou ID externo"
          aria-label="Buscar produtos"
        />
        <Select
          name="marketplace"
          defaultValue={marketplace ?? "ALL"}
          aria-label="Marketplace"
        >
          <option value="ALL">Todos os marketplaces</option>
          <option value="MERCADO_LIVRE">Mercado Livre</option>
          <option value="SHOPEE">Shopee</option>
        </Select>
        <Button type="submit">Filtrar produtos</Button>
      </form>

      {products.length === 0 ? (
        <EmptyState
          title="Nenhum produto encontrado"
          description={
            search || marketplace
              ? "Nenhum produto corresponde aos filtros atuais. Limpe os filtros ou revise a busca."
              : "Os produtos serão criados pelo pipeline de ingestão quando uma oferta for descoberta ou cadastrada."
          }
          actionHref="/ofertas/nova"
          actionLabel="Cadastrar oferta"
        />
      ) : (
        <DataTableContainer label={`Produtos encontrados: ${products.length}`}>
          <table className="w-full min-w-[820px] text-left text-sm">
            <thead className="border-b bg-[var(--muted)] text-xs uppercase text-[var(--muted-foreground)]">
              <tr>
                <th className="px-4 py-3">Produto</th>
                <th className="px-4 py-3">Marketplace</th>
                <th className="px-4 py-3">Categoria</th>
                <th className="px-4 py-3">Ofertas</th>
                <th className="px-4 py-3">Atualizado</th>
                <th className="px-4 py-3">Ação</th>
              </tr>
            </thead>
            <tbody>
              {products.map((product) => (
                <tr key={product.id} className="border-b last:border-0">
                  <td className="max-w-md px-4 py-3">
                    <p className="font-medium">{product.title}</p>
                    <p className="mt-1 font-mono text-xs text-[var(--muted-foreground)]">
                      {product.externalProductId}
                    </p>
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge
                      status="ACTIVE"
                      label={
                        product.marketplace === "MERCADO_LIVRE"
                          ? "Mercado Livre"
                          : "Shopee"
                      }
                      tone="info"
                    />
                  </td>
                  <td className="px-4 py-3">
                    {product.category ?? "Não informada"}
                  </td>
                  <td className="px-4 py-3 tabular-nums">
                    {product._count.offers}
                  </td>
                  <td className="px-4 py-3">
                    {formatDateTime(product.updatedAt)}
                  </td>
                  <td className="px-4 py-3">
                    <Button asChild variant="outline" size="sm">
                      <a
                        href={product.productUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Abrir produto
                        <ExternalLink aria-hidden="true" size={14} />
                      </a>
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </DataTableContainer>
      )}
      <p className="text-xs text-[var(--muted-foreground)]">
        Exibindo até 100 produtos. Use os filtros para refinar a consulta.
      </p>
    </AdminShell>
  );
}
