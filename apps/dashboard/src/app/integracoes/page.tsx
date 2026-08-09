import {
  Bot,
  Cpu,
  KeyRound,
  PlugZap,
  RefreshCw,
  Settings,
  ShoppingBag,
} from "lucide-react";
import {
  OllamaAiProvider,
  getOllamaIntegrationStatus,
  getOpenAiIntegrationStatus,
} from "@affiliate/ai-copywriter";
import { prisma } from "@affiliate/database";
import { resolveShopeeAffiliateConfiguration } from "@affiliate/shopee-affiliate";
import Link from "next/link";
import { AdminShell } from "@/components/admin-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert } from "@/components/ui/alert";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  syncMercadoLivreNowAction,
  testMercadoLivreIntegrationAction,
  testOllamaCopyAction,
  testOpenAiCopyAction,
} from "@/lib/actions";
import { formatDateTime } from "@/lib/format";

export const dynamic = "force-dynamic";

type IntegrationsPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function messageText(message?: string | string[]) {
  const value = Array.isArray(message) ? message[0] : message;

  if (value === "ollama-ok") return "Ollama respondeu com copy validada.";
  if (value === "ollama-fallback")
    return "Teste local concluído com fallback determinístico.";
  if (value === "openai-ok") return "OpenAI respondeu com copy validada.";
  if (value === "openai-fallback")
    return "Teste OpenAI concluído com fallback determinístico.";
  if (value === "meli-connected") return "Mercado Livre conectado com sucesso.";
  if (value === "meli-connect-failed")
    return "Falha ao concluir OAuth do Mercado Livre.";
  if (value === "meli-missing-config")
    return "Configure as variáveis do app Mercado Livre no servidor.";
  if (value === "meli-ok")
    return "Mercado Livre respondeu ao teste de integração.";
  if (value === "meli-not-connected")
    return "Mercado Livre ainda não está conectado.";
  if (value === "meli-auth-error")
    return "Mercado Livre conectado, mas a autenticação precisa de reconexão.";
  if (value === "meli-api-unavailable")
    return "Mercado Livre conectado, mas a API não respondeu ao teste.";
  if (value === "meli-configuration-error")
    return "Configuração do servidor Mercado Livre incompleta ou inválida.";
  if (value === "meli-internal-error")
    return "Erro interno ao testar Mercado Livre. Consulte os logs do servidor.";
  return null;
}

export default async function IntegrationsPage({
  searchParams,
}: IntegrationsPageProps) {
  const params = await searchParams;
  const ollama = getOllamaIntegrationStatus();
  const ollamaHealth = await new OllamaAiProvider().healthCheck();
  const openAi = getOpenAiIntegrationStatus();
  const shopee = resolveShopeeAffiliateConfiguration();
  const message = messageText(params?.message);
  const [mercadoLivreAccount, mercadoLivreConfig] = await Promise.all([
    prisma.marketplaceAccount.findFirst({
      where: { marketplace: "MERCADO_LIVRE" },
      orderBy: { updatedAt: "desc" },
      select: {
        externalUserId: true,
        status: true,
        siteId: true,
        expiresAt: true,
        lastRefreshAt: true,
        lastSyncAt: true,
        lastErrorAt: true,
        lastError: true,
      },
    }),
    prisma.mercadoLivreDiscoveryConfig.findFirst({
      orderBy: { updatedAt: "desc" },
    }),
  ]);

  return (
    <AdminShell currentPath="/integracoes" title="Integrações">
      {message ? (
        <Alert
          tone={
            message.toLocaleLowerCase("pt-BR").includes("falha") ||
            message.toLocaleLowerCase("pt-BR").includes("erro")
              ? "danger"
              : "success"
          }
          live
        >
          {message}
        </Alert>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-3">
              <CardTitle className="flex items-center gap-2">
                <Cpu aria-hidden="true" size={18} />
                Ollama
              </CardTitle>
              <StatusBadge
                status={ollamaHealth.available ? "CONNECTED" : "DEGRADED"}
                label={ollamaHealth.available ? "Disponível" : "Indisponível"}
              />
            </div>
            <p className="text-sm text-[var(--foreground-secondary)]">
              Geração local de textos com fallback determinístico.
            </p>
          </CardHeader>
          <CardContent className="grid gap-4 text-sm">
            <div className="flex items-center justify-between">
              <span>Configurado</span>
              <span className="inline-flex items-center gap-2">
                <StatusBadge
                  status={ollama.configured ? "ACTIVE" : "DISABLED"}
                  label={ollama.configured ? "Configurado" : "Não configurado"}
                />
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span>Disponibilidade</span>
              <span className="inline-flex items-center gap-2">
                {ollamaHealth.available ? "Disponível" : "Indisponível"}
              </span>
            </div>
            <div className="grid gap-1">
              <span className="text-[var(--muted-foreground)]">Base URL</span>
              <span>{ollama.baseUrl}</span>
            </div>
            <div className="grid gap-1">
              <span className="text-[var(--muted-foreground)]">Modelo</span>
              <span>{ollama.model}</span>
            </div>
            <div className="grid gap-1">
              <span className="text-[var(--muted-foreground)]">Status</span>
              <span>{ollamaHealth.status}</span>
            </div>
            <form action={testOllamaCopyAction}>
              <Button type="submit" variant="outline">
                Testar Ollama
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-3">
              <CardTitle className="flex items-center gap-2">
                <ShoppingBag aria-hidden="true" size={18} />
                Shopee
              </CardTitle>
              <StatusBadge
                status={shopee.enabled ? "ACTIVE" : "DISABLED"}
                label={shopee.mode}
              />
            </div>
            <p className="text-sm text-[var(--foreground-secondary)]">
              Datafeeds oficiais processados localmente, com Open API
              fail-closed.
            </p>
          </CardHeader>
          <CardContent className="grid gap-4 text-sm text-[var(--foreground-secondary)]">
            <p>
              Descoberta e preview em streaming. Nenhuma publicação é criada
              enquanto a atribuição dos links não estiver confirmada.
            </p>
            <Button asChild variant="outline">
              <Link href="/integracoes/shopee">
                <Settings aria-hidden="true" size={16} />
                Configurar Datafeeds
              </Link>
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-3">
              <CardTitle className="flex items-center gap-2">
                <Bot aria-hidden="true" size={18} />
                OpenAI
              </CardTitle>
              <StatusBadge
                status={openAi.configured ? "ACTIVE" : "DISABLED"}
                label={openAi.configured ? "Configurada" : "Desabilitada"}
              />
            </div>
            <p className="text-sm text-[var(--foreground-secondary)]">
              Provider opcional configurado exclusivamente no servidor.
            </p>
          </CardHeader>
          <CardContent className="grid gap-4 text-sm">
            <div className="flex items-center justify-between">
              <span>Provider selecionado</span>
              <span className="inline-flex items-center gap-2">
                {openAi.selected ? "Sim" : "Não"}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span>Chave do servidor</span>
              <span className="inline-flex items-center gap-2">
                {openAi.configured ? "Configurada" : "Ausente"}
              </span>
            </div>
            <div className="grid gap-1">
              <span className="text-[var(--muted-foreground)]">Modelo</span>
              <span>{openAi.model}</span>
            </div>
            <form action={testOpenAiCopyAction}>
              <Button
                type="submit"
                variant="outline"
                disabled={!openAi.configured}
              >
                Testar OpenAI
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-3">
              <CardTitle className="flex items-center gap-2">
                <PlugZap aria-hidden="true" size={18} />
                Mercado Livre
              </CardTitle>
              <StatusBadge
                status={mercadoLivreAccount?.status ?? "DISCONNECTED"}
              />
            </div>
            <p className="text-sm text-[var(--foreground-secondary)]">
              OAuth oficial, descoberta por categorias e links afiliados
              autorizados.
            </p>
          </CardHeader>
          <CardContent className="grid gap-4 text-sm">
            <div className="flex items-center justify-between">
              <span>Status</span>
              <StatusBadge
                status={mercadoLivreAccount?.status ?? "DISCONNECTED"}
              />
            </div>
            <div className="grid gap-1">
              <span className="text-[var(--muted-foreground)]">
                ID da conta
              </span>
              <span>{mercadoLivreAccount?.externalUserId ?? "-"}</span>
            </div>
            <div className="grid gap-1">
              <span className="text-[var(--muted-foreground)]">Site</span>
              <span>
                {mercadoLivreAccount?.siteId ??
                  mercadoLivreConfig?.siteId ??
                  "MLB"}
              </span>
            </div>
            <div className="grid gap-1">
              <span className="text-[var(--muted-foreground)]">
                Token expira em
              </span>
              <span>
                {mercadoLivreAccount?.expiresAt
                  ? formatDateTime(mercadoLivreAccount.expiresAt)
                  : "-"}
              </span>
            </div>
            <div className="grid gap-1">
              <span className="text-[var(--muted-foreground)]">
                Última renovação
              </span>
              <span>
                {mercadoLivreAccount?.lastRefreshAt
                  ? formatDateTime(mercadoLivreAccount.lastRefreshAt)
                  : "-"}
              </span>
            </div>
            <div className="grid gap-1">
              <span className="text-[var(--muted-foreground)]">
                Última sincronização
              </span>
              <span>
                {mercadoLivreAccount?.lastSyncAt
                  ? formatDateTime(mercadoLivreAccount.lastSyncAt)
                  : "-"}
              </span>
            </div>
            {mercadoLivreAccount?.lastError ? (
              <div className="grid gap-1 text-[var(--danger)]">
                <span>Último erro</span>
                <span>
                  {mercadoLivreAccount.lastErrorAt
                    ? `${formatDateTime(mercadoLivreAccount.lastErrorAt)} - `
                    : ""}
                  {mercadoLivreAccount.lastError}
                </span>
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="outline">
                <Link href="/api/integrations/mercadolivre/connect">
                  <PlugZap aria-hidden="true" size={16} />
                  {mercadoLivreAccount?.status === "CONNECTED"
                    ? "Reconectar"
                    : "Conectar"}
                </Link>
              </Button>
              <Button asChild variant="outline">
                <Link href="/integracoes/mercado-livre">
                  <Settings aria-hidden="true" size={16} />
                  Configurar
                </Link>
              </Button>
              <form action={testMercadoLivreIntegrationAction}>
                <Button type="submit" variant="outline">
                  Testar
                </Button>
              </form>
              <form action={syncMercadoLivreNowAction}>
                <Button
                  type="submit"
                  variant="outline"
                  disabled={mercadoLivreAccount?.status !== "CONNECTED"}
                >
                  <RefreshCw aria-hidden="true" size={16} />
                  Sincronizar
                </Button>
              </form>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <KeyRound aria-hidden="true" size={18} />
              Segredos
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-[var(--muted-foreground)]">
            Credenciais são lidas de variáveis de ambiente no servidor e nunca
            aparecem no cliente.
          </CardContent>
        </Card>
      </div>
    </AdminShell>
  );
}
