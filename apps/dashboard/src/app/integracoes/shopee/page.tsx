import { DatabaseZap, FileSearch, Link2Off, ShieldCheck } from "lucide-react";
import { AdminShell } from "@/components/admin-shell";
import { Alert } from "@/components/ui/alert";
import { MetricCard, MetricGrid } from "@/components/ui/page";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  SHOPEE_CATEGORY_CATALOG,
  resolveShopeeAffiliateConfiguration,
} from "@affiliate/shopee-affiliate";
import { ShopeeDatafeedConsole } from "./shopee-datafeed-console";

export const dynamic = "force-dynamic";

export default function ShopeeIntegrationPage() {
  const configuration = resolveShopeeAffiliateConfiguration();
  return (
    <AdminShell
      currentPath="/integracoes/shopee"
      title="Shopee Affiliate"
      description="Descoberta segura por Datafeeds oficiais, sem scraping ou acesso externo."
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
            value={configuration.mode === "DATAFEED" ? "Disponível" : "Inativo"}
            detail="Processamento streaming no servidor"
            icon={FileSearch}
          />
          <MetricCard
            label="Open API"
            value="Aguardando acesso"
            detail="Nenhuma chamada está implementada"
            icon={DatabaseZap}
            tone="warning"
          />
          <MetricCard
            label="Atribuição dos links"
            value={
              configuration.linksVerified ? "Verificada" : "Não verificada"
            }
            detail="Publicação permanece bloqueada nesta fase"
            icon={Link2Off}
            tone={configuration.linksVerified ? "success" : "warning"}
          />
        </MetricGrid>

        {!configuration.linksVerified ? (
          <Alert tone="warning" title="Gate de atribuição fechado">
            O link fornecido pelo Datafeed é tratado apenas como candidato. Ele
            não será apresentado como link afiliado confirmado e nenhuma
            Publication será criada.
          </Alert>
        ) : null}

        <ShopeeDatafeedConsole
          configuration={{
            ...configuration,
            categories: SHOPEE_CATEGORY_CATALOG.map((category) => ({
              ...category,
            })),
          }}
        />
      </div>
    </AdminShell>
  );
}
