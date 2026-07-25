import { Bot, CheckCircle2, Cpu, KeyRound, PlugZap, RefreshCw, Settings, XCircle } from "lucide-react";
import {
  OllamaAiProvider,
  getOllamaIntegrationStatus,
  getOpenAiIntegrationStatus,
} from "@affiliate/ai-copywriter";
import { prisma } from "@affiliate/database";
import Link from "next/link";
import { AdminShell } from "@/components/admin-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  if (value === "ollama-fallback") return "Teste local concluido com fallback deterministico.";
  if (value === "openai-ok") return "OpenAI respondeu com copy validada.";
  if (value === "openai-fallback") return "Teste OpenAI concluido com fallback deterministico.";
  if (value === "meli-connected") return "Mercado Livre conectado com sucesso.";
  if (value === "meli-connect-failed") return "Falha ao concluir OAuth do Mercado Livre.";
  if (value === "meli-missing-config") return "Configure as variaveis do app Mercado Livre no servidor.";
  if (value === "meli-ok") return "Mercado Livre respondeu ao teste de integracao.";
  if (value === "meli-not-connected") return "Mercado Livre ainda nao esta conectado.";
  if (value === "meli-auth-error") return "Mercado Livre conectado, mas a autenticacao precisa de reconexao.";
  if (value === "meli-api-unavailable") return "Mercado Livre conectado, mas a API nao respondeu ao teste.";
  if (value === "meli-configuration-error") return "Configuracao servidor do Mercado Livre incompleta ou invalida.";
  if (value === "meli-internal-error") return "Erro interno ao testar Mercado Livre. Consulte os logs do servidor.";
  return null;
}

function StatusIcon({ ok }: { ok: boolean }) {
  return ok ? (
    <CheckCircle2 aria-hidden="true" className="text-green-700" size={18} />
  ) : (
    <XCircle aria-hidden="true" className="text-red-700" size={18} />
  );
}

export default async function IntegrationsPage({ searchParams }: IntegrationsPageProps) {
  const params = await searchParams;
  const ollama = getOllamaIntegrationStatus();
  const ollamaHealth = await new OllamaAiProvider().healthCheck();
  const openAi = getOpenAiIntegrationStatus();
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
    prisma.mercadoLivreDiscoveryConfig.findFirst({ orderBy: { updatedAt: "desc" } }),
  ]);

  return (
    <AdminShell currentPath="/integracoes" title="Integracoes">
      {message ? (
        <div className="rounded-md border bg-white px-4 py-3 text-sm">{message}</div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Cpu aria-hidden="true" size={18} />
              Ollama
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 text-sm">
            <div className="flex items-center justify-between">
              <span>Configurado</span>
              <span className="inline-flex items-center gap-2">
                <StatusIcon ok={ollama.configured} />
                {ollama.configured ? "sim" : "nao"}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span>Disponibilidade</span>
              <span className="inline-flex items-center gap-2">
                <StatusIcon ok={ollamaHealth.available} />
                {ollamaHealth.available ? "disponivel" : "indisponivel"}
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
            <CardTitle className="flex items-center gap-2">
              <Bot aria-hidden="true" size={18} />
              OpenAI
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 text-sm">
            <div className="flex items-center justify-between">
              <span>Provider selecionado</span>
              <span className="inline-flex items-center gap-2">
                <StatusIcon ok={openAi.selected} />
                {openAi.selected ? "sim" : "nao"}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span>Chave do servidor</span>
              <span className="inline-flex items-center gap-2">
                <StatusIcon ok={openAi.configured} />
                {openAi.configured ? "configurada" : "ausente"}
              </span>
            </div>
            <div className="grid gap-1">
              <span className="text-[var(--muted-foreground)]">Modelo</span>
              <span>{openAi.model}</span>
            </div>
            <form action={testOpenAiCopyAction}>
              <Button type="submit" variant="outline" disabled={!openAi.configured}>
                Testar OpenAI
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <PlugZap aria-hidden="true" size={18} />
              Mercado Livre
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 text-sm">
            <div className="flex items-center justify-between">
              <span>Status</span>
              <span className="inline-flex items-center gap-2">
                <StatusIcon ok={mercadoLivreAccount?.status === "CONNECTED"} />
                {mercadoLivreAccount?.status ?? "DISCONNECTED"}
              </span>
            </div>
            <div className="grid gap-1">
              <span className="text-[var(--muted-foreground)]">User ID</span>
              <span>{mercadoLivreAccount?.externalUserId ?? "-"}</span>
            </div>
            <div className="grid gap-1">
              <span className="text-[var(--muted-foreground)]">Site</span>
              <span>{mercadoLivreAccount?.siteId ?? mercadoLivreConfig?.siteId ?? "MLB"}</span>
            </div>
            <div className="grid gap-1">
              <span className="text-[var(--muted-foreground)]">Token expira em</span>
              <span>{mercadoLivreAccount?.expiresAt ? formatDateTime(mercadoLivreAccount.expiresAt) : "-"}</span>
            </div>
            <div className="grid gap-1">
              <span className="text-[var(--muted-foreground)]">Ultimo refresh</span>
              <span>
                {mercadoLivreAccount?.lastRefreshAt ? formatDateTime(mercadoLivreAccount.lastRefreshAt) : "-"}
              </span>
            </div>
            <div className="grid gap-1">
              <span className="text-[var(--muted-foreground)]">Ultima sincronizacao</span>
              <span>{mercadoLivreAccount?.lastSyncAt ? formatDateTime(mercadoLivreAccount.lastSyncAt) : "-"}</span>
            </div>
            {mercadoLivreAccount?.lastError ? (
              <div className="grid gap-1 text-red-700">
                <span>Ultimo erro</span>
                <span>
                  {mercadoLivreAccount.lastErrorAt ? `${formatDateTime(mercadoLivreAccount.lastErrorAt)} - ` : ""}
                  {mercadoLivreAccount.lastError}
                </span>
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="outline">
                <Link href="/api/integrations/mercadolivre/connect">
                  <PlugZap aria-hidden="true" size={16} />
                  {mercadoLivreAccount?.status === "CONNECTED" ? "Reconectar" : "Conectar"}
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
                <Button type="submit" variant="outline" disabled={mercadoLivreAccount?.status !== "CONNECTED"}>
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
            Credenciais sao lidas de variaveis de ambiente no servidor e nao aparecem no cliente.
          </CardContent>
        </Card>
      </div>
    </AdminShell>
  );
}
