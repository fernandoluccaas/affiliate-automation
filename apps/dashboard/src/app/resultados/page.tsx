import { prisma, type Marketplace } from "@affiliate/database";
import { collectAnalytics, trackingStatusSnapshot } from "@affiliate/tracking";
import { AdminShell } from "@/components/admin-shell";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";

export const dynamic = "force-dynamic";

type ResultsPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function single(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function safeDay(value: string | undefined, fallback: Date) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return fallback;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function dayInput(value: Date) {
  return value.toISOString().slice(0, 10);
}

function Metric(props: { label: string; value: string | number; detail?: string }) {
  return (
    <div className="rounded-md border bg-white p-4">
      <p className="text-sm text-[var(--muted-foreground)]">{props.label}</p>
      <p className="mt-2 text-2xl font-semibold">{props.value}</p>
      {props.detail ? <p className="mt-1 text-xs">{props.detail}</p> : null}
    </div>
  );
}

function PerformanceTable(props: {
  title: string;
  keyLabel: string;
  rows: Array<{ key: string; clicks: number; conversions: number; conversionRate: number }>;
}) {
  return (
    <section className="rounded-md border bg-white p-4">
      <h2 className="font-semibold">{props.title}</h2>
      {props.rows.length === 0 ? <p className="mt-2 text-sm">Sem dados no período.</p> : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[520px] text-left text-sm">
            <thead><tr className="border-b"><th className="py-2">{props.keyLabel}</th><th>Clicks</th><th>Conversões</th><th>Taxa</th></tr></thead>
            <tbody>{props.rows.map((row) => <tr key={row.key} className="border-b"><td className="py-2">{row.key}</td><td>{row.clicks}</td><td>{row.conversions}</td><td>{row.conversionRate}%</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default async function ResultsPage({ searchParams }: ResultsPageProps) {
  const params = await searchParams;
  const today = new Date();
  const defaultFrom = new Date(today.getTime() - 30 * 86_400_000);
  const from = safeDay(single(params?.from), defaultFrom);
  const selectedTo = safeDay(single(params?.to), today);
  const to = new Date(selectedTo.getTime() + 86_400_000);
  const marketplaceValue = single(params?.marketplace);
  const marketplace = ["MERCADO_LIVRE", "SHOPEE"].includes(marketplaceValue ?? "")
    ? (marketplaceValue as Marketplace)
    : undefined;
  const channelValue = single(params?.channelId);
  const channelId = channelValue && /^[a-zA-Z0-9_-]{1,64}$/.test(channelValue)
    ? channelValue
    : undefined;
  const periodValid = to > from && to.getTime() - from.getTime() <= 366 * 86_400_000;
  const [analytics, channels, tracking] = await Promise.all([
    periodValid
      ? collectAnalytics({ from, to, ...(marketplace ? { marketplace } : {}), ...(channelId ? { channelId } : {}) })
      : null,
    prisma.channel.findMany({
      where: { enabled: true },
      orderBy: { name: "asc" },
      take: 100,
      select: { id: true, name: true },
    }),
    trackingStatusSnapshot(),
  ]);
  const findings = [
    ...tracking.preflight.blockers,
    ...(tracking.operational.unattributedConversions > 0 ? ["CONVERSIONS_UNATTRIBUTED"] : []),
    ...(tracking.operational.orphanCommissions > 0 ? ["COMMISSIONS_ORPHANED"] : []),
    ...(tracking.operational.abandonedImports > 0 ? ["FINANCIAL_IMPORT_ABANDONED"] : []),
    ...(tracking.operational.failedImports > 0 ? ["FINANCIAL_IMPORT_FAILED"] : []),
  ];

  return (
    <AdminShell currentPath="/resultados" title="Resultados">
      <p className="rounded-md border border-blue-200 bg-blue-50 p-3 text-sm">
        Relatório administrativo somente leitura. Moedas permanecem separadas e
        atribuições ambíguas nunca são tratadas como conversões atribuídas.
      </p>
      <section className="rounded-md border bg-white p-4">
        <h2 className="font-semibold">Estado do tracking e ações humanas</h2>
        <p className="mt-1 text-sm">
          {tracking.configuration.state} / Redis {tracking.preflight.redis} /
          secret configurado {String(tracking.configuration.fingerprintSecretConfigured)}
        </p>
        {findings.length === 0 ? (
          <p className="mt-2 text-sm">Nenhum finding de tracking.</p>
        ) : (
          <ul className="mt-2 grid gap-1 text-sm">{findings.map((finding) => <li key={finding}>{finding}</li>)}</ul>
        )}
      </section>
      <form className="grid gap-3 rounded-md border bg-white p-4 md:grid-cols-5">
        <label className="grid gap-1 text-sm">
          De
          <input className="rounded-md border px-3 py-2" type="date" name="from" defaultValue={dayInput(from)} />
        </label>
        <label className="grid gap-1 text-sm">
          Até
          <input className="rounded-md border px-3 py-2" type="date" name="to" defaultValue={dayInput(selectedTo)} />
        </label>
        <label className="grid gap-1 text-sm">
          Marketplace
          <Select name="marketplace" defaultValue={marketplace ?? "ALL"}>
            <option value="ALL">Todos</option>
            <option value="MERCADO_LIVRE">Mercado Livre</option>
            <option value="SHOPEE">Shopee</option>
          </Select>
        </label>
        <label className="grid gap-1 text-sm">
          Canal
          <Select name="channelId" defaultValue={channelId ?? "ALL"}>
            <option value="ALL">Todos</option>
            {channels.map((channel) => <option key={channel.id} value={channel.id}>{channel.name}</option>)}
          </Select>
        </label>
        <Button className="self-end" type="submit">Filtrar</Button>
      </form>

      {!periodValid || !analytics ? (
        <p className="rounded-md border border-red-200 bg-red-50 p-4 text-sm">
          Período inválido. Selecione até 366 dias, com a data final posterior à inicial.
        </p>
      ) : (
        <>
          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Metric label="Redirects" value={analytics.redirects} />
            <Metric label="Clicks persistidos" value={analytics.clicksPersisted} detail={`${analytics.uniqueClicksApproximate} únicos aproximados`} />
            <Metric label="Conversões" value={analytics.conversions} detail={`${analytics.conversionRate}% dos clicks`} />
            <Metric label="Atribuídas" value={analytics.attributedConversions} detail={`${analytics.unattributedConversions} não atribuídas / ${analytics.ambiguousConversions} ambíguas`} />
            <Metric label="Deduplicados" value={analytics.clicksDeduplicated} />
            <Metric label="Rate limited" value={analytics.clicksRateLimited} />
            <Metric label="Tracking degradado" value={analytics.trackingDegraded} />
            <Metric label="Destinos bloqueados" value={analytics.destinationsBlocked} />
          </section>

          <section className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-md border bg-white p-4">
              <h2 className="font-semibold">Receita por moeda</h2>
              {analytics.revenueByCurrency.length === 0 ? <p className="mt-2 text-sm">Sem dados no período.</p> : (
                <ul className="mt-3 grid gap-2 text-sm">{analytics.revenueByCurrency.map((row) => (
                  <li key={row.currency} className="rounded border p-2">{row.currency}: {row.amount.toFixed(2)} ({row.conversions} conversões)</li>
                ))}</ul>
              )}
            </div>
            <div className="rounded-md border bg-white p-4">
              <h2 className="font-semibold">Comissões por moeda e status</h2>
              {analytics.commissionsByCurrencyAndStatus.length === 0 ? <p className="mt-2 text-sm">Sem dados no período.</p> : (
                <ul className="mt-3 grid gap-2 text-sm">{analytics.commissionsByCurrencyAndStatus.map((row) => (
                  <li key={`${row.currency}-${row.status}`} className="rounded border p-2">{row.currency} / {row.status}: {row.amount.toFixed(2)} ({row.commissions})</li>
                ))}</ul>
              )}
              {analytics.averageCommissionByCurrency.length ? (
                <p className="mt-3 text-xs text-[var(--muted-foreground)]">
                  Média: {analytics.averageCommissionByCurrency.map((row) => `${row.currency} ${row.average.toFixed(2)}`).join(" / ")}
                </p>
              ) : null}
            </div>
          </section>

          <PerformanceTable title="Desempenho por marketplace" keyLabel="Marketplace" rows={analytics.byMarketplace} />
          <div className="grid gap-4 lg:grid-cols-3">
            <PerformanceTable title="Desempenho por canal" keyLabel="Canal (ID truncado)" rows={analytics.byChannel} />
            <PerformanceTable title="Desempenho por oferta" keyLabel="Oferta (ID truncado)" rows={analytics.byOffer} />
            <PerformanceTable title="Desempenho por publicação" keyLabel="Publicação (ID truncado)" rows={analytics.byPublication} />
          </div>

          <section className="rounded-md border bg-white p-4">
            <h2 className="font-semibold">Imports financeiros recentes</h2>
            {analytics.imports.length === 0 ? <p className="mt-2 text-sm">Nenhum import no período.</p> : (
              <ul className="mt-3 grid gap-2 text-sm">{analytics.imports.map((job) => (
                <li key={job.id} className="rounded border p-2">{job.marketplace} / {job.importType} / {job.status} — {job.totalCreated} criados, {job.totalFailed} falhas</li>
              ))}</ul>
            )}
          </section>
        </>
      )}
    </AdminShell>
  );
}
