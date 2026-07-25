import { ArrowLeft, Plus, RefreshCw, Save, Search } from "lucide-react";
import Link from "next/link";
import { prisma } from "@affiliate/database";
import { createMercadoLivreConnector, type MercadoLivreCategory } from "@affiliate/marketplace-connectors";
import { AdminShell } from "@/components/admin-shell";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  addMercadoLivreCategoryAction,
  saveMercadoLivreConfigAction,
  syncMercadoLivreNowAction,
  testMercadoLivreCategoryAction,
} from "@/lib/actions";
import { formatDateTime } from "@/lib/format";

export const dynamic = "force-dynamic";

type MercadoLivrePageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function messageText(message?: string | string[]) {
  const value = Array.isArray(message) ? message[0] : message;

  if (value === "config-saved") return "Configuracao salva.";
  if (value === "config-invalid") return "Revise os campos da configuracao.";
  if (value === "category-added") return "Categoria folha adicionada.";
  if (value === "category-invalid") return "Informe um ID de categoria valido.";
  if (value === "category-not-found") return "Categoria nao encontrada no Mercado Livre.";
  if (value === "category-api-error") return "Nao foi possivel consultar a categoria no Mercado Livre.";
  if (value === "category-not-leaf") {
    return "Esta categoria possui subcategorias. Selecione uma categoria mais especifica para usar o ranking de mais vendidos.";
  }
  if (value === "category-tested") return "Teste de categoria concluido.";
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

function single(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function categoryPath(category: MercadoLivreCategory | null) {
  if (!category) {
    return "-";
  }

  const path = category.pathFromRoot.length > 0 ? category.pathFromRoot : [{ id: category.id, name: category.name }];
  return path.map((item) => item.name).filter(Boolean).join(" > ");
}

async function categoryDetailsFor(categoryId: string, connector: Awaited<ReturnType<typeof createMercadoLivreConnector>>) {
  return connector.getCategory(categoryId).catch(() => null);
}

export default async function MercadoLivreIntegrationPage({ searchParams }: MercadoLivrePageProps) {
  const params = await searchParams;
  const message = messageText(params?.message);
  const selectedCategoryId = single(params?.categoryId);
  const [account, config] = await Promise.all([
    prisma.marketplaceAccount.findFirst({
      where: { marketplace: "MERCADO_LIVRE" },
      orderBy: { updatedAt: "desc" },
    }),
    prisma.mercadoLivreDiscoveryConfig.findFirst({ orderBy: { updatedAt: "desc" } }),
  ]);
  const categoryIds = jsonStringArray(config?.categoryIds);
  const metrics = lastRunMetrics(config?.lastRunSummary);
  const connector = account?.status === "CONNECTED" ? await createMercadoLivreConnector().catch(() => null) : null;
  const selectedCategory =
    connector && selectedCategoryId ? await categoryDetailsFor(selectedCategoryId, connector) : null;
  const baseCategories = connector
    ? selectedCategory
      ? await connector.getCategoryChildren(selectedCategory.id).catch(() => [])
      : await connector.getSiteCategories().catch(() => [])
    : [];
  const categoryRows = connector
    ? await Promise.all(
        baseCategories.map(async (category) => ({
          summary: category,
          details: await categoryDetailsFor(category.id, connector),
        })),
      )
    : [];
  const configuredCategories = connector
    ? await Promise.all(
        categoryIds.map(async (categoryId) => ({
          id: categoryId,
          details: await categoryDetailsFor(categoryId, connector),
        })),
      )
    : categoryIds.map((categoryId) => ({ id: categoryId, details: null }));
  const testResult = single(params?.message) === "category-tested" ? params : null;

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
                  placeholder="MLB123456, MLB654321"
                />
                <p className="text-xs text-[var(--muted-foreground)]">
                  Opcional para ajuste manual. Ao salvar, cada ID e validado no Mercado Livre. Para ranking de mais
                  vendidos, use categorias folha.
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

      <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Seletor de categorias</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            {connector ? (
              <>
                <div className="rounded-md border bg-[var(--background)] p-3 text-sm">
                  <div className="text-xs text-[var(--muted-foreground)]">Caminho atual</div>
                  <div className="mt-1 font-medium">{selectedCategory ? categoryPath(selectedCategory) : "Categorias principais MLB"}</div>
                  {selectedCategory ? (
                    <div className="mt-1 text-xs text-[var(--muted-foreground)]">{selectedCategory.id}</div>
                  ) : null}
                </div>

                {selectedCategory ? (
                  <div className="flex flex-wrap gap-2">
                    <Button asChild variant="outline">
                      <Link href="/integracoes/mercado-livre">Voltar para categorias principais</Link>
                    </Button>
                    {selectedCategory.pathFromRoot.length > 1 ? (
                      <Button asChild variant="outline">
                        <Link
                          href={`/integracoes/mercado-livre?categoryId=${encodeURIComponent(
                            selectedCategory.pathFromRoot[selectedCategory.pathFromRoot.length - 2]?.id ?? "",
                          )}`}
                        >
                          Voltar um nivel
                        </Link>
                      </Button>
                    ) : null}
                  </div>
                ) : null}

                {categoryRows.length === 0 ? (
                  <EmptyState
                    title="Categoria folha"
                    description="Esta categoria nao possui subcategorias. Ela pode ser adicionada para discovery por ranking quando houver highlights disponiveis."
                  />
                ) : (
                  <div className="grid gap-3">
                    {categoryRows.map(({ summary, details }) => {
                      const isLeaf = (details?.children.length ?? 1) === 0;

                      return (
                        <div key={summary.id} className="grid gap-3 rounded-md border bg-white p-4 md:grid-cols-[1fr_auto]">
                          <div>
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-medium">{details?.name ?? summary.name}</span>
                              <span className="rounded-md border bg-[var(--background)] px-2 py-1 text-xs">
                                {isLeaf ? "CATEGORIA FOLHA" : "CATEGORIA"}
                              </span>
                            </div>
                            <div className="mt-1 text-xs text-[var(--muted-foreground)]">
                              {details ? categoryPath(details) : summary.name}
                            </div>
                            <div className="mt-1 text-xs text-[var(--muted-foreground)]">{summary.id}</div>
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            {isLeaf ? (
                              <form action={addMercadoLivreCategoryAction}>
                                <input name="categoryId" type="hidden" value={summary.id} />
                                <Button type="submit" variant="outline">
                                  <Plus aria-hidden="true" size={16} />
                                  Adicionar
                                </Button>
                              </form>
                            ) : (
                              <Button asChild variant="outline">
                                <Link href={`/integracoes/mercado-livre?categoryId=${encodeURIComponent(summary.id)}`}>
                                  Abrir subcategorias
                                </Link>
                              </Button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            ) : (
              <EmptyState
                title="Conecte o Mercado Livre"
                description="O seletor hierarquico consulta categorias oficiais usando a conta conectada."
                actionHref="/api/integrations/mercadolivre/connect"
                actionLabel="Conectar Mercado Livre"
              />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Testar categoria</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 text-sm">
            <form action={testMercadoLivreCategoryAction} className="grid gap-3">
              <Field label="ID da categoria">
                <Input name="categoryId" defaultValue={selectedCategory?.id ?? selectedCategoryId ?? ""} placeholder="MLB123456" />
              </Field>
              <Button type="submit" variant="outline" disabled={!connector}>
                <Search aria-hidden="true" size={16} />
                Testar categoria
              </Button>
            </form>

            {testResult ? (
              <dl className="grid gap-2 rounded-md border bg-[var(--background)] p-3">
                <Result label="Nome" value={single(testResult.categoryName) ?? "-"} />
                <Result label="ID" value={single(testResult.categoryId) ?? "-"} />
                <Result label="Caminho" value={single(testResult.categoryPath) ?? "-"} />
                <Result label="Categoria folha" value={single(testResult.categoryLeaf) === "true" ? "sim" : "nao"} />
                <Result label="Subcategorias" value={single(testResult.categoryChildrenCount) ?? "0"} />
                <Result label="Highlights disponiveis" value={single(testResult.highlightsAvailable) === "true" ? "sim" : "nao"} />
                <Result label="Candidatos encontrados" value={single(testResult.candidatesFound) ?? "0"} />
                <Result label="Motivo highlights" value={single(testResult.highlightsReason) ?? "-"} />
              </dl>
            ) : null}

            <div className="grid gap-2">
              <div className="font-medium">Categorias configuradas</div>
              {configuredCategories.length === 0 ? (
                <p className="text-[var(--muted-foreground)]">Nenhuma categoria configurada.</p>
              ) : (
                <div className="grid gap-2">
                  {configuredCategories.map((category) => (
                    <div key={category.id} className="rounded-md border bg-white p-3">
                      <div className="font-medium">{category.details?.name ?? category.id}</div>
                      <div className="text-xs text-[var(--muted-foreground)]">
                        {category.details ? categoryPath(category.details) : "Detalhes indisponiveis"}
                      </div>
                      <div className="text-xs text-[var(--muted-foreground)]">{category.id}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
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

function Result({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1">
      <dt className="text-xs text-[var(--muted-foreground)]">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
