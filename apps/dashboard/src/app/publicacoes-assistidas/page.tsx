import {
  prisma,
  type Marketplace,
  type Prisma,
  type PublicationStatus,
} from "@affiliate/database";
import { AdminShell } from "@/components/admin-shell";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { MetricCard, MetricGrid } from "@/components/ui/page";
import {
  ASSISTED_GROUP_INTRO,
  groupDisplayNameFromSnapshot,
} from "@/lib/assisted-publications";
import { AssistedPublicationCard } from "./assisted-publication-card";

export const dynamic = "force-dynamic";

function payloadMessage(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const message = (value as Record<string, unknown>).message;
  return typeof message === "string" ? message : "";
}

type AssistedPublicationsPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

const filterStatuses: PublicationStatus[] = [
  "AWAITING_MANUAL_PUBLICATION",
  "PUBLISHED",
  "CANCELLED",
  "PUBLICATION_FAILED",
  "FAILED",
];

function param(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function AssistedPublicationsPage({
  searchParams,
}: AssistedPublicationsPageProps) {
  const params = await searchParams;
  const groupId = param(params?.groupId) ?? "";
  const statusValue = param(params?.status) ?? "AWAITING_MANUAL_PUBLICATION";
  const marketplaceValue = param(params?.marketplace) ?? "";
  const dateValue = param(params?.date) ?? "";
  const status = filterStatuses.includes(statusValue as PublicationStatus)
    ? (statusValue as PublicationStatus)
    : null;
  const marketplace = ["MERCADO_LIVRE", "SHOPEE"].includes(marketplaceValue)
    ? (marketplaceValue as Marketplace)
    : null;
  const dateStart = /^\d{4}-\d{2}-\d{2}$/.test(dateValue)
    ? new Date(`${dateValue}T00:00:00.000Z`)
    : null;
  const where: Prisma.PublicationWhereInput = {
    channel: {
      type: "WHATSAPP_GROUPS",
      ...(groupId ? { id: groupId } : {}),
    },
    ...(statusValue !== "ALL" && status ? { status } : {}),
    ...(marketplace ? { marketplaceSnapshot: marketplace } : {}),
    ...(dateStart
      ? {
          scheduledAt: {
            gte: dateStart,
            lt: new Date(dateStart.getTime() + 24 * 60 * 60 * 1000),
          },
        }
      : {}),
  };

  const [publications, statusCounts, groups] = await Promise.all([
    prisma.publication.findMany({
      where,
      include: {
        channel: { select: { name: true, configuration: true } },
      },
      orderBy: { scheduledAt: "asc" },
      take: 100,
    }),
    prisma.publication.groupBy({
      by: ["status"],
      where: { channel: { type: "WHATSAPP_GROUPS" } },
      _count: { _all: true },
    }),
    prisma.channel.findMany({
      where: { type: "WHATSAPP_GROUPS" },
      orderBy: { name: "asc" },
      select: { id: true, name: true, configuration: true },
    }),
  ]);
  const count = (status: string) =>
    statusCounts.find((item) => item.status === status)?._count._all ?? 0;

  return (
    <AdminShell currentPath="/publicacoes-assistidas" title="Fila WhatsApp">
      <p className="text-sm text-[var(--muted-foreground)]">
        {ASSISTED_GROUP_INTRO}
      </p>
      <form
        aria-label="Filtros da fila WhatsApp"
        className="grid gap-3 rounded-[var(--radius-lg)] border bg-[var(--surface)] p-4 shadow-[var(--shadow-sm)] md:grid-cols-5"
      >
        <Select name="groupId" defaultValue={groupId} aria-label="Grupo">
          <option value="">Todos os grupos</option>
          {groups.map((group) => (
            <option key={group.id} value={group.id}>
              {groupDisplayNameFromSnapshot(
                null,
                group.configuration,
                group.name,
              )}
            </option>
          ))}
        </Select>
        <Select name="status" defaultValue={statusValue} aria-label="Status">
          <option value="ALL">Todos os status</option>
          {filterStatuses.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </Select>
        <Select
          name="marketplace"
          defaultValue={marketplaceValue}
          aria-label="Marketplace"
        >
          <option value="">Todos os marketplaces</option>
          <option value="MERCADO_LIVRE">Mercado Livre</option>
          <option value="SHOPEE">Shopee</option>
        </Select>
        <Input
          name="date"
          type="date"
          defaultValue={dateValue}
          aria-label="Data"
        />
        <Button type="submit">Filtrar</Button>
      </form>
      <MetricGrid>
        <Metric
          label="Preparadas"
          value={count("AWAITING_MANUAL_PUBLICATION")}
        />
        <Metric label="Confirmadas" value={count("PUBLISHED")} />
        <Metric label="Ignoradas" value={count("CANCELLED")} />
        <Metric
          label="Falhas"
          value={count("PUBLICATION_FAILED") + count("FAILED")}
        />
      </MetricGrid>
      {publications.length === 0 ? (
        <EmptyState
          title="Nenhuma publicação encontrada"
          description="O worker preparará novas pendências conforme as regras e os limites de cada grupo. Ajuste os filtros para consultar outros estados."
        />
      ) : (
        <div className="grid gap-4">
          {publications.map((publication) => {
            const message = payloadMessage(publication.messagePayload);
            const groupDisplayName = groupDisplayNameFromSnapshot(
              publication.metadata,
              publication.channel.configuration,
              publication.channel.name,
            );
            return (
              <AssistedPublicationCard
                key={publication.id}
                id={publication.id}
                groupDisplayName={groupDisplayName}
                status={publication.status}
                marketplace={publication.marketplaceSnapshot}
                headline={
                  message.split(/\r?\n/).find(Boolean) ??
                  publication.offerTitleSnapshot
                }
                title={publication.offerTitleSnapshot}
                price={new Intl.NumberFormat("pt-BR", {
                  style: "currency",
                  currency: "BRL",
                }).format(Number(publication.currentPriceSnapshot))}
                message={message}
                affiliateUrl={
                  publication.affiliateUrlSnapshot ??
                  publication.trackingUrlSnapshot
                }
                hasImage={Boolean(publication.imageUrlSnapshot)}
                preparedAt={publication.scheduledAt.toLocaleString("pt-BR", {
                  timeZone: "America/Fortaleza",
                })}
              />
            );
          })}
        </div>
      )}
    </AdminShell>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return <MetricCard label={label} value={value} />;
}
