import { Bot, CheckCircle2, Cpu, KeyRound, PlugZap, XCircle } from "lucide-react";
import {
  OllamaAiProvider,
  getOllamaIntegrationStatus,
  getOpenAiIntegrationStatus,
} from "@affiliate/ai-copywriter";
import { AdminShell } from "@/components/admin-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { testOllamaCopyAction, testOpenAiCopyAction } from "@/lib/actions";

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
              Marketplaces
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-[var(--muted-foreground)]">
            Conectores reais de Shopee e Mercado Livre permanecem indisponiveis nesta fase.
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
