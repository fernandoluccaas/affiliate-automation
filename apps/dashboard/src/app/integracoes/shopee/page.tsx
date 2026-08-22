import {
  Clock3,
  DatabaseZap,
  FileSearch,
  Link2Off,
  ShieldCheck,
} from "lucide-react";
import { AdminShell } from "@/components/admin-shell";
import { Alert } from "@/components/ui/alert";
import { MetricCard, MetricGrid } from "@/components/ui/page";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  SHOPEE_CATEGORY_CATALOG,
  getShopeeScheduledDiscoveryStatus,
  loadShopeeOperationalOfferState,
  resolveShopeeAffiliateConfiguration,
} from "@affiliate/shopee-affiliate";
import { ShopeeDatafeedConsole } from "./shopee-datafeed-console";

export const dynamic = "force-dynamic";

function dateTime(value: string | null) {
  return value
    ? new Intl.DateTimeFormat("pt-BR", {
        dateStyle: "short",
        timeStyle: "short",
        timeZone: "America/Fortaleza",
      }).format(new Date(value))
    : "Ainda não executada";
}

export default async function ShopeeIntegrationPage() {
  const configuration = resolveShopeeAffiliateConfiguration();
  const [offerState, scheduledDiscovery] = await Promise.all([
    loadShopeeOperationalOfferState(),
    getShopeeScheduledDiscoveryStatus(),
  ]);
  const automationState =
    scheduledDiscovery.lastRunStatus === "RUNNING"
      ? "Em execução"
      : scheduledDiscovery.lastRunStatus === "FAILED"
        ? "Erro"
        : scheduledDiscovery.autoRunReady
          ? "Pronta"
          : "Não pronta";
  return (
    <AdminShell
      currentPath="/integracoes/shopee"
      title="Shopee Affiliate"
      description="Descoberta por fonte oficial e geração de links, sem scraping."
      actions={
        <StatusBadge
          status={configuration.enabled ? "ACTIVE" : "DISABLED"}
          label={configuration.mode}
        />
      }
    >
      <div className="grid gap-6">
        <MetricGrid>
          <MetricCard
            label="Integração"
            value={configuration.enabled ? "Ativa" : "Desativada"}
            detail={`Modo ${configuration.mode}`}
            icon={ShieldCheck}
            tone={configuration.enabled ? "success" : "default"}
          />
          <MetricCard
            label="Datafeed local"
            value={
              ["DATAFEED", "HYBRID"].includes(configuration.mode)
                ? "Disponível"
                : "Inativo"
            }
            detail="Processamento streaming no servidor"
            icon={FileSearch}
          />
          <MetricCard
            label="Fonte de discovery"
            value={configuration.discoverySource}
            detail={
              configuration.remoteDiscoveryReady
                ? "Open API Feed oficial pronta"
                : "Arquivo local preservado; feed remoto desativado"
            }
            icon={FileSearch}
            tone={configuration.remoteDiscoveryReady ? "success" : "default"}
          />
          <MetricCard
            label="Open API"
            value={
              configuration.openApiConfigured
                ? "Configurada"
                : "Não configurada"
            }
            detail={
              configuration.openApiReady
                ? "Geração de links disponível"
                : "Fail-closed"
            }
            icon={DatabaseZap}
            tone="warning"
          />
          <MetricCard
            label="Auto-link"
            value={configuration.autoLinkAfterImport ? "Ativado" : "Desativado"}
            detail="Executado somente depois de uma importação confirmada"
            icon={DatabaseZap}
            tone={configuration.autoLinkAfterImport ? "success" : "default"}
          />
          <MetricCard
            label="Links candidatos do Datafeed"
            value={
              configuration.linksVerified ? "Verificada" : "Não verificada"
            }
            detail="Somente links gerados ou validados podem liberar a oferta"
            icon={Link2Off}
            tone={configuration.linksVerified ? "success" : "warning"}
          />
        </MetricGrid>

        <MetricGrid>
          <MetricCard
            label="Automação de descoberta"
            value={
              scheduledDiscovery.automatedDiscoveryEnabled
                ? "Ativada"
                : "Desativada"
            }
            detail={`${automationState} · intervalo de ${scheduledDiscovery.intervalHours}h`}
            icon={Clock3}
            tone={scheduledDiscovery.autoRunReady ? "success" : "default"}
          />
          <MetricCard
            label="Última execução"
            value={dateTime(scheduledDiscovery.lastScheduledRunAt)}
            detail={`${scheduledDiscovery.lastFeedsProcessed} feeds processados`}
            icon={Clock3}
          />
          <MetricCard
            label="Próxima execução"
            value={
              scheduledDiscovery.due
                ? "Pendente agora"
                : dateTime(scheduledDiscovery.nextScheduledRunAt)
            }
            detail="Persistida por AutomationRun"
            icon={Clock3}
          />
          <MetricCard
            label="Itens analisados"
            value={scheduledDiscovery.lastItemsReceived}
            detail={`${scheduledDiscovery.lastSelected} ofertas selecionadas`}
            icon={FileSearch}
          />
          <MetricCard
            label="Ofertas importadas"
            value={scheduledDiscovery.lastImported}
            detail={`${scheduledDiscovery.lastReadyToPublish} prontas para publicação`}
            icon={DatabaseZap}
          />
          <MetricCard
            label="Links gerados"
            value={scheduledDiscovery.lastLinksGenerated}
            detail={
              scheduledDiscovery.lastErrorCode
                ? `Último erro: ${scheduledDiscovery.lastErrorCode}`
                : `${scheduledDiscovery.lastPendingAffiliateLink} ainda pendentes`
            }
            icon={Link2Off}
            tone={scheduledDiscovery.lastErrorCode ? "warning" : "default"}
          />
        </MetricGrid>

        {!configuration.linksVerified ? (
          <Alert tone="warning" title="Links do Datafeed não verificados">
            O link fornecido pelo Datafeed é tratado apenas como candidato. Ele
            não será usado como afiliado; a Open API ou o fallback manual devem
            gerar um link válido. Nenhuma Publication é criada por este fluxo.
          </Alert>
        ) : null}

        <ShopeeDatafeedConsole
          configuration={{
            ...configuration,
            offerCounts: offerState.offerCounts,
            pendingOffers: offerState.pendingOffers,
            categories: SHOPEE_CATEGORY_CATALOG.map((category) => ({
              ...category,
            })),
          }}
        />
      </div>
    </AdminShell>
  );
}
