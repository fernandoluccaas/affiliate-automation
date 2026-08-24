import { prisma } from "@affiliate/database";
import { resolveCouponIntelligenceConfiguration } from "@affiliate/shared";
import { AdminShell } from "@/components/admin-shell";
import { EmptyState } from "@/components/empty-state";
import { DataTableContainer } from "@/components/ui/table";
import { StatusBadge } from "@/components/ui/status-badge";
import { formatCurrency, formatDateTime } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function CouponsPage() {
  const coupons = await prisma.coupon.findMany({
    orderBy: { updatedAt: "desc" },
    take: 100,
    include: {
      offer: {
        select: { title: true, marketplace: true, currentPrice: true },
      },
    },
  });
  const now = new Date();
  const configuration = resolveCouponIntelligenceConfiguration();

  const benefit = (coupon: (typeof coupons)[number]) => {
    if (coupon.percentage) return `${coupon.percentage.toString()}% OFF`;
    if (coupon.discountAmount)
      return `${formatCurrency(coupon.discountAmount)} OFF`;
    return coupon.autoApply ? "Aplicação automática" : "Não informado";
  };

  return (
    <AdminShell currentPath="/cupons" title="Cupons">
      {coupons.length === 0 ? (
        <EmptyState
          title="Nenhum cupom disponível"
          description="Cupons associados às ofertas aparecerão aqui com validade, aplicabilidade e origem. Você também pode informar um cupom ao cadastrar uma oferta manual."
          actionHref="/ofertas/nova"
          actionLabel="Cadastrar oferta com cupom"
        />
      ) : (
        <DataTableContainer label={`Cupons encontrados: ${coupons.length}`}>
          <table className="w-full min-w-[1120px] text-left text-sm">
            <thead className="border-b bg-[var(--muted)] text-xs uppercase text-[var(--muted-foreground)]">
              <tr>
                <th className="px-4 py-3">Código</th>
                <th className="px-4 py-3">Oferta</th>
                <th className="px-4 py-3">Marketplace</th>
                <th className="px-4 py-3">Benefício</th>
                <th className="px-4 py-3">Aplicabilidade</th>
                <th className="px-4 py-3">Preço efetivo</th>
                <th className="px-4 py-3">Validade</th>
                <th className="px-4 py-3">Origem</th>
                <th className="px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {coupons.map((coupon) => {
                const expired = Boolean(
                  coupon.expiresAt && coupon.expiresAt < now,
                );
                const stale = Boolean(
                  !coupon.lastValidatedAt ||
                    now.getTime() - coupon.lastValidatedAt.getTime() >
                      configuration.refreshTtlMinutes * 60_000 ||
                    Boolean(
                      coupon.itemPrice &&
                        coupon.itemPrice.toString() !==
                          coupon.offer.currentPrice.toString(),
                    ),
                );
                const expiringSoon = Boolean(
                  coupon.expiresAt &&
                    coupon.expiresAt.getTime() <=
                      now.getTime() +
                        configuration.expirySafetyMinutes * 60_000,
                );
                const status = expired
                  ? { value: "DISABLED", label: "Cupom expirado" }
                  : stale
                    ? { value: "WARNING", label: "Cupom stale" }
                    : expiringSoon
                      ? { value: "WARNING", label: "Cupom expirando" }
                      : coupon.applicability === "CONFIRMED"
                        ? { value: "ACTIVE", label: "Cupom confirmado" }
                        : coupon.applicability === "CONDITIONAL"
                          ? { value: "WARNING", label: "Cupom condicional" }
                          : { value: "DISABLED", label: "Sem confirmação" };
                return (
                  <tr key={coupon.id} className="border-b last:border-0">
                    <td className="px-4 py-3 font-mono font-semibold">
                      {coupon.code || (coupon.autoApply ? "Automático" : "-")}
                    </td>
                    <td className="max-w-sm px-4 py-3">{coupon.offer.title}</td>
                    <td className="px-4 py-3">{coupon.offer.marketplace}</td>
                    <td className="px-4 py-3">
                      {benefit(coupon)}
                      {coupon.minimumSpend ? (
                        <div className="text-xs text-[var(--muted-foreground)]">
                          Mínimo {formatCurrency(coupon.minimumSpend)}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">
                      {coupon.applicability}
                      {coupon.applicabilityReason ? (
                        <div className="text-xs text-[var(--muted-foreground)]">
                          {coupon.applicabilityReason}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">
                      {coupon.applicability === "CONFIRMED" &&
                      coupon.calculatedEffectivePrice
                        ? formatCurrency(coupon.calculatedEffectivePrice)
                        : "Não calculado"}
                    </td>
                    <td className="px-4 py-3">
                      {coupon.expiresAt
                        ? formatDateTime(coupon.expiresAt)
                        : "Sem validade informada"}
                    </td>
                    <td className="px-4 py-3">
                      <div>{coupon.source}</div>
                      <div className="text-xs text-[var(--muted-foreground)]">
                        {coupon.lastValidatedAt
                          ? `Validado ${formatDateTime(coupon.lastValidatedAt)}`
                          : "Não validado"}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={status.value} label={status.label} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </DataTableContainer>
      )}
    </AdminShell>
  );
}
