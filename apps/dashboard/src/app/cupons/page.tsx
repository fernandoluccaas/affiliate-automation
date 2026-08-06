import { prisma } from "@affiliate/database";
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
    include: { offer: { select: { title: true, marketplace: true } } },
  });
  const now = new Date();

  return (
    <AdminShell currentPath="/cupons" title="Cupons">
      {coupons.length === 0 ? (
        <EmptyState
          title="Nenhum cupom disponível"
          description="Cupons associados às ofertas aparecerão aqui com validade e valor. Você também pode informar um cupom ao cadastrar uma oferta manual."
          actionHref="/ofertas/nova"
          actionLabel="Cadastrar oferta com cupom"
        />
      ) : (
        <DataTableContainer label={`Cupons encontrados: ${coupons.length}`}>
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="border-b bg-[var(--muted)] text-xs uppercase text-[var(--muted-foreground)]">
              <tr>
                <th className="px-4 py-3">Código</th>
                <th className="px-4 py-3">Oferta</th>
                <th className="px-4 py-3">Marketplace</th>
                <th className="px-4 py-3">Desconto</th>
                <th className="px-4 py-3">Validade</th>
                <th className="px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {coupons.map((coupon) => {
                const expired = Boolean(
                  coupon.expiresAt && coupon.expiresAt < now,
                );
                return (
                  <tr key={coupon.id} className="border-b last:border-0">
                    <td className="px-4 py-3 font-mono font-semibold">
                      {coupon.code}
                    </td>
                    <td className="max-w-sm px-4 py-3">{coupon.offer.title}</td>
                    <td className="px-4 py-3">{coupon.offer.marketplace}</td>
                    <td className="px-4 py-3">
                      {coupon.discountAmount
                        ? formatCurrency(coupon.discountAmount)
                        : "Não informado"}
                    </td>
                    <td className="px-4 py-3">
                      {coupon.expiresAt
                        ? formatDateTime(coupon.expiresAt)
                        : "Sem validade informada"}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge
                        status={expired ? "DISABLED" : "ACTIVE"}
                        label={expired ? "Expirado" : "Válido"}
                      />
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
