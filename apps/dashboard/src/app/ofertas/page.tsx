import { Plus } from "lucide-react";
import Link from "next/link";
import { prisma } from "@affiliate/database";
import { marketplaces, offerStatuses, stockStatuses } from "@affiliate/shared";
import { AdminShell } from "@/components/admin-shell";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { formatCurrency, formatDateTime, formatPercentage } from "@/lib/format";

export const dynamic = "force-dynamic";

type OffersPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function single(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function buildPageHref(params: URLSearchParams, page: number) {
  const next = new URLSearchParams(params);
  next.set("page", String(page));
  return `/ofertas?${next.toString()}`;
}

export default async function OffersPage({ searchParams }: OffersPageProps) {
  const params = await searchParams;
  const marketplace = single(params?.marketplace);
  const status = single(params?.status);
  const category = single(params?.category)?.trim();
  const page = Math.max(1, Number(single(params?.page) ?? 1));
  const pageSize = 10;
  const queryParams = new URLSearchParams();

  if (marketplace) {
    queryParams.set("marketplace", marketplace);
  }

  if (status) {
    queryParams.set("status", status);
  }

  if (category) {
    queryParams.set("category", category);
  }

  const where = {
    ...(marketplaces.includes(marketplace as (typeof marketplaces)[number])
      ? { marketplace: marketplace as (typeof marketplaces)[number] }
      : {}),
    ...(offerStatuses.includes(status as (typeof offerStatuses)[number])
      ? { status: status as (typeof offerStatuses)[number] }
      : {}),
    ...(category ? { category: { contains: category, mode: "insensitive" as const } } : {}),
  };

  const [offers, total] = await Promise.all([
    prisma.offer.findMany({
      where,
      orderBy: { collectedAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        marketplace: true,
        externalProductId: true,
        version: true,
        title: true,
        category: true,
        originalPrice: true,
        currentPrice: true,
        discountPercentage: true,
        score: true,
        stockStatus: true,
        couponCode: true,
        collectedAt: true,
        status: true,
        statusReason: true,
      },
    }),
    prisma.offer.count({ where }),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <AdminShell
      currentPath="/ofertas"
      title="Ofertas"
      actions={
        <Button asChild>
          <Link href="/ofertas/nova">
            <Plus aria-hidden="true" size={18} />
            Nova oferta
          </Link>
        </Button>
      }
    >
      <form className="grid gap-3 rounded-md border bg-white p-4 md:grid-cols-[1fr_1fr_1fr_auto]">
        <Select name="marketplace" defaultValue={marketplace ?? ""} aria-label="Marketplace">
          <option value="">Todos marketplaces</option>
          {marketplaces.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </Select>
        <Select name="status" defaultValue={status ?? ""} aria-label="Status">
          <option value="">Todos status</option>
          {offerStatuses.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </Select>
        <input
          name="category"
          defaultValue={category ?? ""}
          placeholder="Categoria"
          className="h-10 rounded-md border bg-white px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        />
        <Button type="submit">Filtrar</Button>
      </form>

      {offers.length === 0 ? (
        <EmptyState
          title="Nenhuma oferta encontrada"
          description="Cadastre uma oferta manualmente ou ajuste os filtros para consultar ofertas existentes."
          actionHref="/ofertas/nova"
          actionLabel="Cadastrar oferta"
        />
      ) : (
        <div className="overflow-x-auto rounded-md border bg-white">
          <table className="w-full min-w-[980px] border-collapse text-left text-sm">
            <thead className="border-b bg-[var(--muted)] text-xs uppercase text-[var(--muted-foreground)]">
              <tr>
                <th className="px-4 py-3 font-semibold">Titulo</th>
                <th className="px-4 py-3 font-semibold">Marketplace</th>
                <th className="px-4 py-3 font-semibold">ID externo</th>
                <th className="px-4 py-3 font-semibold">Versao</th>
                <th className="px-4 py-3 font-semibold">Categoria</th>
                <th className="px-4 py-3 font-semibold">Precos</th>
                <th className="px-4 py-3 font-semibold">Desconto</th>
                <th className="px-4 py-3 font-semibold">Score</th>
                <th className="px-4 py-3 font-semibold">Estoque</th>
                <th className="px-4 py-3 font-semibold">Cupom</th>
                <th className="px-4 py-3 font-semibold">Data</th>
                <th className="px-4 py-3 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {offers.map((offer) => (
                <tr key={offer.id} className="border-b last:border-0">
                  <td className="max-w-[260px] px-4 py-3">
                    <div className="font-medium">{offer.title}</div>
                    {offer.statusReason ? (
                      <div className="mt-1 text-xs text-[var(--muted-foreground)]">
                        {offer.statusReason}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-4 py-3">{offer.marketplace}</td>
                  <td className="px-4 py-3">{offer.externalProductId}</td>
                  <td className="px-4 py-3">v{offer.version}</td>
                  <td className="px-4 py-3">{offer.category ?? "-"}</td>
                  <td className="px-4 py-3">
                    <div>{formatCurrency(offer.currentPrice)}</div>
                    <div className="text-xs text-[var(--muted-foreground)]">
                      De {formatCurrency(offer.originalPrice)}
                    </div>
                  </td>
                  <td className="px-4 py-3">{formatPercentage(offer.discountPercentage)}%</td>
                  <td className="px-4 py-3">{offer.score ?? "-"}</td>
                  <td className="px-4 py-3">
                    {stockStatuses.includes(offer.stockStatus) ? offer.stockStatus : "-"}
                  </td>
                  <td className="px-4 py-3">{offer.couponCode ?? "-"}</td>
                  <td className="px-4 py-3">{formatDateTime(offer.collectedAt)}</td>
                  <td className="px-4 py-3">
                    <span className="rounded-md border bg-[var(--background)] px-2 py-1 text-xs font-medium">
                      {offer.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-center justify-between text-sm text-[var(--muted-foreground)]">
        <span>
          Pagina {page} de {totalPages} - {total} oferta{total === 1 ? "" : "s"}
        </span>
        <div className="flex gap-2">
          {page <= 1 ? (
            <Button variant="outline" disabled>
              Anterior
            </Button>
          ) : (
            <Button asChild variant="outline">
              <Link href={buildPageHref(queryParams, page - 1)}>Anterior</Link>
            </Button>
          )}
          {page >= totalPages ? (
            <Button variant="outline" disabled>
              Proxima
            </Button>
          ) : (
            <Button asChild variant="outline">
              <Link href={buildPageHref(queryParams, page + 1)}>Proxima</Link>
            </Button>
          )}
        </div>
      </div>
    </AdminShell>
  );
}
