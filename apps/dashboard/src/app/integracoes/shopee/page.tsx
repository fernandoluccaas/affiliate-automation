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
import { prisma } from "@affiliate/database";

export const dynamic = "force-dynamic";

export default async function ShopeeIntegrationPage() {
  const configuration = resolveShopeeAffiliateConfiguration();
  const [pending, ready, pendingOffers] = await Promise.all([
    prisma.offer.count({
      where: { marketplace: "SHOPEE", status: "READY_FOR_AFFILIATE_LINK" },
    }),
    prisma.offer.count({
      where: { marketplace: "SHOPEE", status: "READY_TO_PUBLISH" },
    }),
    prisma.offer.findMany({
      where: { marketplace: "SHOPEE", status: "READY_FOR_AFFILIATE_LINK" },
      orderBy: { updatedAt: "desc" },
      take: 20,
      select: {
        id: true,
        title: true,
        externalProductId: true,
        statusReason: true,
      },
    }),
  ]);
  return (
    <AdminShell
      currentPath="/integracoes/shopee"
      title="Shopee Affiliate"
      description="Descoberta por Datafeeds e geração oficial de links, sem scraping."
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
            label="Open API"
            value={
              configuration.openApiConfigured
                ? "Configurada"
                : "Não configurada"
            }
            detail={
              configuration.openApiReady
                ? "Geração automática disponível"
                : "Fail-closed"
            }
            icon={DatabaseZap}
            tone="warning"
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
            offerCounts: { pending, ready },
            pendingOffers,
            categories: SHOPEE_CATEGORY_CATALOG.map((category) => ({
              ...category,
            })),
          }}
        />
      </div>
    </AdminShell>
  );
}
