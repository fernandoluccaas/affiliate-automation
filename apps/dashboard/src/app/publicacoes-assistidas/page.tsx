import { prisma } from "@affiliate/database";
import { AdminShell } from "@/components/admin-shell";
import { EmptyState } from "@/components/empty-state";
import { AssistedPublicationCard } from "./assisted-publication-card";

export const dynamic = "force-dynamic";

function payloadMessage(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const message = (value as Record<string, unknown>).message;
  return typeof message === "string" ? message : "";
}

export default async function AssistedPublicationsPage() {
  const [publications, statusCounts] = await Promise.all([
    prisma.publication.findMany({
      where: {
        status: "AWAITING_MANUAL_PUBLICATION",
        channel: { type: "WHATSAPP_CHANNEL" },
      },
      include: { channel: { select: { name: true } } },
      orderBy: { scheduledAt: "asc" },
      take: 100,
    }),
    prisma.publication.groupBy({
      by: ["status"],
      where: { channel: { type: "WHATSAPP_CHANNEL" } },
      _count: { _all: true },
    }),
  ]);
  const count = (status: string) =>
    statusCounts.find((item) => item.status === status)?._count._all ?? 0;

  return (
    <AdminShell currentPath="/publicacoes-assistidas" title="Publicacoes assistidas">
      <p className="text-sm text-[var(--muted-foreground)]">
        O texto exibido e o snapshot imutavel que sera copiado. Publique no Canal e confirme manualmente.
      </p>
      <div className="grid gap-3 sm:grid-cols-4">
        <Metric label="Preparadas" value={count("AWAITING_MANUAL_PUBLICATION")} />
        <Metric label="Confirmadas" value={count("PUBLISHED")} />
        <Metric label="Ignoradas" value={count("CANCELLED")} />
        <Metric label="Falhas" value={count("PUBLICATION_FAILED") + count("FAILED")} />
      </div>
      {publications.length === 0 ? (
        <EmptyState title="Nenhuma publicacao pendente" description="O worker preparara novas pendencias conforme as regras e limites do Canal." />
      ) : (
        <div className="grid gap-4">
          {publications.map((publication) => {
            const message = payloadMessage(publication.messagePayload);
            return (
              <AssistedPublicationCard
                key={publication.id}
                id={publication.id}
                channelName={publication.channel.name}
                headline={message.split(/\r?\n/).find(Boolean) ?? publication.offerTitleSnapshot}
                title={publication.offerTitleSnapshot}
                price={new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(publication.currentPriceSnapshot))}
                message={message}
                affiliateUrl={publication.affiliateUrlSnapshot ?? publication.trackingUrlSnapshot}
                hasImage={Boolean(publication.imageUrlSnapshot)}
                preparedAt={publication.scheduledAt.toLocaleString("pt-BR", { timeZone: "America/Fortaleza" })}
              />
            );
          })}
        </div>
      )}
    </AdminShell>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border bg-white p-3">
      <p className="text-xs text-[var(--muted-foreground)]">{label}</p>
      <p className="text-2xl font-semibold">{value}</p>
    </div>
  );
}
