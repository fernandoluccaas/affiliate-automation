import { Plus } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { prisma } from "@affiliate/database";
import { marketplaces, offerStatuses, stockStatuses } from "@affiliate/shared";
import { AdminShell } from "@/components/admin-shell";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { StatusBadge } from "@/components/ui/status-badge";
import { DataTableContainer, Pagination } from "@/components/ui/table";
import { formatCurrency, formatDateTime, formatPercentage } from "@/lib/format";
import { CopyAffiliateLinkButton } from "./copy-affiliate-link-button";

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
  const affiliateEligibility = single(params?.affiliateEligibility);
  const affiliateLinkMissing = single(params?.affiliateLinkMissing);
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

  if (affiliateEligibility) {
    queryParams.set("affiliateEligibility", affiliateEligibility);
  }

  if (affiliateLinkMissing) {
    queryParams.set("affiliateLinkMissing", affiliateLinkMissing);
  }

  const where = {
    ...(marketplaces.includes(marketplace as (typeof marketplaces)[number])
      ? { marketplace: marketplace as (typeof marketplaces)[number] }
      : {}),
    ...(offerStatuses.includes(status as (typeof offerStatuses)[number])
      ? { status: status as (typeof offerStatuses)[number] }
      : {}),
    ...(category
      ? { category: { contains: category, mode: "insensitive" as const } }
      : {}),
    ...(["ELIGIBLE", "INELIGIBLE", "UNKNOWN"].includes(
      affiliateEligibility ?? "",
    )
      ? {
          affiliateEligibility: affiliateEligibility as
            "ELIGIBLE" | "INELIGIBLE" | "UNKNOWN",
        }
      : {}),
    ...(affiliateLinkMissing === "true" ? { affiliateUrl: null } : {}),
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
        imageUrl: true,
        productUrl: true,
        category: true,
        sourceCategoryId: true,
        bestSellerPosition: true,
        sourceHighlightId: true,
        sourceHighlightType: true,
        resolutionStrategy: true,
        originalPrice: true,
        currentPrice: true,
        discountPercentage: true,
        score: true,
        scoreCompletenessPercentage: true,
        shippingStatus: true,
        stockStatus: true,
        couponCode: true,
        collectedAt: true,
        status: true,
        statusReason: true,
        affiliateUrl: true,
        affiliateEligibility: true,
        trackingStrategy: true,
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
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <Link href="/ofertas/affiliate-links">Links afiliados</Link>
          </Button>
          <Button asChild>
            <Link href="/ofertas/nova">
              <Plus aria-hidden="true" size={18} />
              Nova oferta
            </Link>
          </Button>
        </div>
      }
    >
      <form
        aria-label="Filtros de ofertas"
        className="grid gap-3 rounded-[var(--radius-lg)] border bg-[var(--surface)] p-4 shadow-[var(--shadow-sm)] md:grid-cols-2 xl:grid-cols-[1fr_1fr_1fr_1fr_1fr_auto]"
      >
        <Select
          name="marketplace"
          defaultValue={marketplace ?? ""}
          aria-label="Marketplace"
        >
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
              {item === "READY_FOR_AFFILIATE_LINK"
                ? "Aguardando link"
                : item === "READY_TO_PUBLISH"
                  ? "Prontas para publicar"
                  : item}
            </option>
          ))}
        </Select>
        <Input
          name="category"
          defaultValue={category ?? ""}
          placeholder="Categoria"
          aria-label="Categoria"
        />
        <Select
          name="affiliateEligibility"
          defaultValue={affiliateEligibility ?? ""}
          aria-label="Elegibilidade afiliado"
        >
          <option value="">Todas elegibilidades</option>
          <option value="ELIGIBLE">ELIGIBLE</option>
          <option value="INELIGIBLE">Link/oferta invalido</option>
          <option value="UNKNOWN">UNKNOWN</option>
        </Select>
        <Select
          name="affiliateLinkMissing"
          defaultValue={affiliateLinkMissing ?? ""}
          aria-label="Link afiliado ausente"
        >
          <option value="">Todos links</option>
          <option value="true">Sem affiliateUrl</option>
        </Select>
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
        <DataTableContainer label="Lista de ofertas com rolagem horizontal">
          <table className="w-full min-w-[1380px] border-collapse text-left text-sm">
            <thead className="border-b bg-[var(--muted)] text-xs uppercase text-[var(--muted-foreground)]">
              <tr>
                <th className="px-4 py-3 font-semibold">Título</th>
                <th className="px-4 py-3 font-semibold">Marketplace</th>
                <th className="px-4 py-3 font-semibold">ID externo</th>
                <th className="px-4 py-3 font-semibold">Versão</th>
                <th className="px-4 py-3 font-semibold">Categoria</th>
                <th className="px-4 py-3 font-semibold">Origem ranking</th>
                <th className="px-4 py-3 font-semibold">Preços</th>
                <th className="px-4 py-3 font-semibold">Desconto</th>
                <th className="px-4 py-3 font-semibold">Score</th>
                <th className="px-4 py-3 font-semibold">Afiliado</th>
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
                    <div className="flex items-start gap-3">
                      {offer.imageUrl ? (
                        <Image
                          src={offer.imageUrl}
                          alt=""
                          width={64}
                          height={64}
                          unoptimized
                          className="h-16 w-16 rounded-md border object-cover"
                        />
                      ) : null}
                      <div className="font-medium">{offer.title}</div>
                    </div>
                    <a
                      className="mt-1 inline-block text-xs text-[var(--primary)] underline-offset-2 hover:underline"
                      href={offer.productUrl}
                      rel="noreferrer"
                      target="_blank"
                    >
                      abrir produto
                    </a>
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
                  <td className="max-w-[240px] px-4 py-3">
                    <div>
                      {offer.bestSellerPosition === null
                        ? "Sem posição"
                        : `#${offer.bestSellerPosition} mais vendido`}
                    </div>
                    <div className="text-xs text-[var(--muted-foreground)]">
                      categoria: {offer.sourceCategoryId ?? "-"}
                    </div>
                    <div className="text-xs text-[var(--muted-foreground)]">
                      {offer.sourceHighlightType ?? "-"} ·{" "}
                      {offer.resolutionStrategy ?? "-"}
                    </div>
                    {offer.sourceHighlightId ? (
                      <div className="break-all text-xs text-[var(--muted-foreground)]">
                        origem: {offer.sourceHighlightId}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-4 py-3">
                    <div>{formatCurrency(offer.currentPrice)}</div>
                    <div className="text-xs text-[var(--muted-foreground)]">
                      {offer.originalPrice
                        ? `De ${formatCurrency(offer.originalPrice)}`
                        : "Preço original indisponível"}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {offer.discountPercentage === null
                      ? "-"
                      : `${formatPercentage(offer.discountPercentage)}%`}
                  </td>
                  <td className="px-4 py-3">
                    {offer.score ?? "-"}
                    {offer.scoreCompletenessPercentage !== null ? (
                      <div className="text-xs text-[var(--muted-foreground)]">
                        {formatPercentage(offer.scoreCompletenessPercentage)}%
                        completude
                      </div>
                    ) : null}
                  </td>
                  <td className="px-4 py-3">
                    {offer.affiliateEligibility}
                    <div className="text-xs text-[var(--muted-foreground)]">
                      {offer.affiliateUrl ? (
                        <span className="grid gap-2">
                          <a
                            className="text-[var(--primary)] underline-offset-2 hover:underline"
                            href={offer.affiliateUrl}
                            rel="noreferrer"
                            target="_blank"
                          >
                            abrir link afiliado
                          </a>
                          <CopyAffiliateLinkButton value={offer.affiliateUrl} />
                        </span>
                      ) : (
                        "sem link afiliado"
                      )}{" "}
                      · {offer.trackingStrategy}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {stockStatuses.includes(offer.stockStatus)
                      ? offer.stockStatus
                      : "-"}
                    <div className="text-xs text-[var(--muted-foreground)]">
                      {offer.shippingStatus}
                    </div>
                  </td>
                  <td className="px-4 py-3">{offer.couponCode ?? "-"}</td>
                  <td className="px-4 py-3">
                    {formatDateTime(offer.collectedAt)}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={offer.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </DataTableContainer>
      )}

      <Pagination
        summary={
          <>
            Página {page} de {totalPages} — {total} oferta
            {total === 1 ? "" : "s"}
          </>
        }
      >
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
            Próxima
          </Button>
        ) : (
          <Button asChild variant="outline">
            <Link href={buildPageHref(queryParams, page + 1)}>Próxima</Link>
          </Button>
        )}
      </Pagination>
    </AdminShell>
  );
}
