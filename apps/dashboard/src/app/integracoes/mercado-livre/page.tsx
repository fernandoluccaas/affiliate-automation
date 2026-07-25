import { ArrowLeft, RefreshCw, Save } from "lucide-react";
import Link from "next/link";
import { prisma } from "@affiliate/database";
import { AdminShell } from "@/components/admin-shell";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { saveMercadoLivreConfigAction, syncMercadoLivreNowAction } from "@/lib/actions";
import { formatDateTime } from "@/lib/format";

export const dynamic = "force-dynamic";

type MercadoLivrePageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function messageText(message?: string | string[]) {
  const value = Array.isArray(message) ? message[0] : message;

  if (value === "config-saved") return "Configuracao salva.";
  if (value === "config-invalid") return "Revise os campos da configuracao.";
  if (value === "sync-ok") return "Sincronizacao manual concluida.";
  if (value === "sync-failed") return "Sincronizacao manual falhou. Veja logs e alertas.";
  return null;
}

function jsonStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function lastRunMetrics(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }

  return Object.entries(value as Record<string, unknown>).filter(([, item]) => typeof item === "number");
}

export default async function MercadoLivreIntegrationPage({ searchParams }: MercadoLivrePageProps) {
  const params = await searchParams;
  const message = messageText(params?.message);
  const [account, config] = await Promise.all([
    prisma.marketplaceAccount.findFirst({
      where: { marketplace: "MERCADO_LIVRE" },
      orderBy: { updatedAt: "desc" },
    }),
    prisma.mercadoLivreDiscoveryConfig.findFirst({ orderBy: { updatedAt: "desc" } }),
  ]);
  const categoryIds = jsonStringArray(config?.categoryIds);
  const metrics = lastRunMetrics(config?.lastRunSummary);

  return (
    <AdminShell currentPath="/integracoes" title="Mercado Livre">
      <div className="flex flex-wrap gap-2">
        <Button asChild variant="outline">
          <Link href="/integracoes">
            <ArrowLeft aria-hidden="true" size={16} />
            Integracoes
          </Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/api/integrations/mercadolivre/connect">
            {account?.status === "CONNECTED" ? "Reconectar" : "Conectar"}
          </Link>
        </Button>
        <form action={syncMercadoLivreNowAction}>
          <Button type="submit" variant="outline" disabled={account?.status !== "CONNECTED"}>
            <RefreshCw aria-hidden="true" size={16} />
            Sincronizar agora
          </Button>
        </form>
      </div>

      {message ? <div className="rounded-md border bg-white px-4 py-3 text-sm">{message}</div> : null}

      <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Discovery</CardTitle>
          </CardHeader>
          <CardContent>
            <form action={saveMercadoLivreConfigAction} className="grid gap-4">
              <label className="flex items-center gap-2 text-sm">
                <input name="enabled" type="checkbox" defaultChecked={config?.enabled ?? false} />
                Integracao ativa
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input name="bestSellersEnabled" type="checkbox" defaultChecked={config?.bestSellersEnabled ?? true} />
                Usar ranking oficial de mais vendidos
              </label>

              <div className="grid gap-4 md:grid-cols-2">
                <Field label="Site ID">
                  <Input name="siteId" defaultValue={config?.siteId ?? account?.siteId ?? "MLB"} />
                </Field>
                <Field label="Maximo por categoria">
                  <Input
                    name="maxCandidatesPerCategory"
                    type="number"
                    min={1}
                    max={20}
                    defaultValue={config?.maxCandidatesPerCategory ?? 20}
                  />
                </Field>
                <Field label="Preco minimo">
                  <Input name="minimumPrice" inputMode="decimal" defaultValue={config?.minimumPrice?.toString() ?? ""} />
                </Field>
                <Field label="Preco maximo">
                  <Input name="maximumPrice" inputMode="decimal" defaultValue={config?.maximumPrice?.toString() ?? ""} />
                </Field>
                <Field label="Desconto minimo (%)">
                  <Input
                    name="minimumDiscountPercentage"
                    inputMode="decimal"
                    defaultValue={config?.minimumDiscountPercentage?.toString() ?? ""}
                  />
                </Field>
                <Field label="Score minimo">
                  <Input name="minimumScore" type="number" min={0} max={100} defaultValue={config?.minimumScore ?? 70} />
                </Field>
                <Field label="Intervalo de refresh (min)">
                  <Input
                    name="refreshIntervalMinutes"
                    type="number"
                    min={15}
                    defaultValue={config?.refreshIntervalMinutes ?? 360}
                  />
                </Field>
              </div>

              <Field label="Categorias">
                <Textarea
                  name="categoryIds"
                  defaultValue={categoryIds.join(", ")}
                  placeholder="MLB1055, MLB1648"
                />
                <p className="text-xs text-[var(--muted-foreground)]">
                  Informe IDs oficiais separados por virgula. A coleta usa os highlights dessas categorias.
                </p>
              </Field>

              <Button type="submit">
                <Save aria-hidden="true" size={16} />
                Salvar configuracao
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Ultima execucao</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 text-sm">
            <div className="grid gap-1">
              <span className="text-[var(--muted-foreground)]">Conta</span>
              <span>{account?.status ?? "DISCONNECTED"}</span>
            </div>
            <div className="grid gap-1">
              <span className="text-[var(--muted-foreground)]">Ultima sincronizacao</span>
              <span>{config?.lastRunAt ? formatDateTime(config.lastRunAt) : "-"}</span>
            </div>
            {metrics.length === 0 ? (
              <EmptyState
                title="Sem execucoes registradas"
                description="Execute uma sincronizacao manual ou aguarde o worker coletar candidatos."
              />
            ) : (
              <dl className="grid grid-cols-2 gap-3">
                {metrics.map(([key, value]) => (
                  <div key={key} className="rounded-md border bg-[var(--background)] p-3">
                    <dt className="text-xs text-[var(--muted-foreground)]">{key}</dt>
                    <dd className="text-lg font-semibold">{String(value)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </CardContent>
        </Card>
      </div>
    </AdminShell>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-2">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
