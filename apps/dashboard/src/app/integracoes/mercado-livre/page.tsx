import { ArrowLeft, Plus, RefreshCw, Save, Search } from "lucide-react";
import Link from "next/link";
import { prisma } from "@affiliate/database";
import {
  createMercadoLivreConnector,
  parseMercadoLivreAffiliateTags,
  sanitizeMercadoLivreAffiliateErrorMessage,
  type MercadoLivreCategory,
} from "@affiliate/marketplace-connectors";
import { AdminShell } from "@/components/admin-shell";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  addMercadoLivreCategoryAction,
  probeMercadoLivreCategorySearchAction,
  saveMercadoLivreConfigAction,
  syncMercadoLivreNowAction,
  testMercadoLivreCategoryAction,
} from "@/lib/actions";
import { formatDateTime } from "@/lib/format";
import {
  clearMercadoLivreAffiliateSessionAction,
  generateMercadoLivreAffiliateTestLinkAction,
  generatePendingMercadoLivreAffiliateLinksAction,
  saveMercadoLivreAffiliateSessionAction,
  selectMercadoLivreAffiliateTagAction,
  testMercadoLivreAffiliateSessionAction,
} from "@/lib/mercadolivre-affiliate-actions";

export const dynamic = "force-dynamic";

type MercadoLivrePageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

type SearchParamRecord = Record<string, string | string[] | undefined>;

function messageText(message?: string | string[]) {
  const value = Array.isArray(message) ? message[0] : message;

  if (value === "config-saved") return "Configuracao salva.";
  if (value === "config-invalid") return "Revise os campos da configuracao.";
  if (value === "category-added") return "Categoria folha adicionada.";
  if (value === "category-invalid") return "Informe um ID de categoria valido.";
  if (value === "category-not-found")
    return "Categoria nao encontrada no Mercado Livre.";
  if (value === "category-api-error")
    return "Nao foi possivel consultar a categoria no Mercado Livre.";
  if (value === "category-not-leaf") {
    return "Esta categoria possui subcategorias. Selecione uma categoria mais especifica para usar o ranking de mais vendidos.";
  }
  if (value === "category-tested") return "Teste de categoria concluido.";
  if (value === "sync-ok")
    return "Importação dos mais vendidos concluída. Consulte as métricas reais da última execução.";
  if (value === "sync-partial")
    return "Importação concluída parcialmente. Consulte as métricas e alertas.";
  if (value === "sync-already-running")
    return "Ja existe uma sincronizacao Mercado Livre em andamento.";
  if (value === "sync-source-disabled")
    return "Discovery por highlights esta desabilitado.";
  if (value === "sync-failed")
    return "A importação falhou. Veja os alertas antes de tentar novamente.";
  if (value === "category-search-tested")
    return "Probe de busca da categoria concluido.";
  if (value === "affiliate-session-saved")
    return "Sessão de afiliado salva e validada.";
  if (value === "affiliate-session-tested")
    return "Conexão com o Portal de Afiliados validada.";
  if (value === "affiliate-session-cleared")
    return "Sessão de afiliado removida.";
  if (value === "affiliate-tag-selected") return "Tag de afiliado atualizada.";
  if (value === "affiliate-test-link-generated")
    return "Link meli.la de teste gerado pelo Portal de Afiliados.";
  if (value === "affiliate-links-generated")
    return "Geração dos links pendentes concluída.";
  if (value === "affiliate-links-partial")
    return "Alguns links foram gerados; os demais continuam pendentes.";
  if (value === "affiliate-links-none")
    return "Não há ofertas pendentes para gerar links.";
  if (value === "affiliate-not-authorized")
    return "Seu perfil não tem permissão para alterar esta integração.";
  if (value === "affiliate-session-invalid")
    return "Revise o cookie, o link de referência e a tag informados.";
  if (value === "affiliate-session-expired")
    return "O cookie do Portal de Afiliados expirou. Substitua-o para continuar.";
  if (value === "affiliate-session-error")
    return "Não foi possível validar a sessão de afiliado.";
  return null;
}

function affiliateSessionStatusLabel(status?: string | null) {
  if (status === "VALIDATING") return "Validando";
  if (status === "CONNECTED") return "Conectado";
  if (status === "EXPIRED") return "Cookie expirado";
  if (status === "ERROR") return "Erro";
  return "Não configurado";
}

function jsonStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function lastRunMetrics(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }

  return Object.entries(value as Record<string, unknown>).filter(
    ([, item]) => typeof item === "number",
  );
}

function lastRunObjectMetrics(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }

  return Object.entries(value as Record<string, unknown>)
    .filter(
      ([, item]) => item && typeof item === "object" && !Array.isArray(item),
    )
    .map(
      ([key, item]) =>
        [
          key,
          Object.entries(item as Record<string, unknown>).filter(
            ([, count]) => typeof count === "number",
          ),
        ] as const,
    )
    .filter(([, entries]) => entries.length > 0);
}

function importJobStatusLabel(status: string) {
  if (status === "QUEUED") return "Na fila";
  if (status === "RUNNING") return "Em execução";
  if (status === "SUCCEEDED") return "Concluída";
  if (status === "SUCCEEDED_WITH_ERRORS") return "Concluída com erros";
  if (status === "FAILED") return "Falhou";
  return status;
}

function sanitizedImportError(value: string | null) {
  if (!value) return "-";

  return sanitizeMercadoLivreAffiliateErrorMessage(value);
}

function single(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function probeSample(value: string | string[] | undefined) {
  const raw = single(value);

  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);

    return Array.isArray(parsed)
      ? parsed
          .filter(
            (item): item is { itemId: string; title?: string } =>
              item &&
              typeof item === "object" &&
              typeof (item as { itemId?: unknown }).itemId === "string",
          )
          .slice(0, 5)
      : [];
  } catch {
    return [];
  }
}

function probeCause(value: string | string[] | undefined) {
  const raw = single(value);

  if (!raw) return "-";

  try {
    const parsed = JSON.parse(raw);

    if (!Array.isArray(parsed)) return "-";

    const entries = parsed.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return [];
      }

      const cause = item as Record<string, unknown>;
      const parts = [
        cause.code,
        cause.message,
        cause.type,
        cause.department,
        cause.causeId,
      ].filter((part): part is string => typeof part === "string" && !!part);

      return parts.length > 0 ? [parts.join(": ")] : [];
    });

    return entries.length > 0 ? entries.join(" | ") : "-";
  } catch {
    return "-";
  }
}

function CategorySearchAttempt({
  label,
  prefix,
  result,
}: {
  label: string;
  prefix: "probeAuthenticated" | "probePublic";
  result: SearchParamRecord;
}) {
  const attempted = single(result[`${prefix}Attempted`]) === "true";

  if (!attempted) {
    return (
      <div className="grid gap-1 border-t pt-3">
        <div className="text-sm font-medium">{label}</div>
        <p className="text-xs text-[var(--muted-foreground)]">
          Nao executada. A tentativa autenticada foi bem-sucedida e o
          short-circuit esta ativo.
        </p>
      </div>
    );
  }

  const authenticationMode = single(result[`${prefix}AuthenticationMode`]);
  const sample = probeSample(result[`${prefix}Sample`]);

  return (
    <div className="grid gap-3 border-t pt-3">
      <div className="text-sm font-medium">{label}</div>
      <dl className="grid gap-2">
        <Result
          label="Modo de autenticacao"
          value={
            authenticationMode === "BEARER_TOKEN"
              ? "Bearer token (token oculto)"
              : "Publico, sem Authorization"
          }
        />
        <Result
          label="API respondeu"
          value={
            single(result[`${prefix}ApiResponded`]) === "true" ? "sim" : "nao"
          }
        />
        <Result
          label="HTTP"
          value={single(result[`${prefix}HttpStatus`]) || "-"}
        />
        <Result
          label="Resultados encontrados"
          value={single(result[`${prefix}ResultsFound`]) ?? "0"}
        />
        <Result
          label="Itens utilizaveis"
          value={single(result[`${prefix}UsableItems`]) ?? "0"}
        />
        <Result
          label="Erro do probe"
          value={single(result[`${prefix}ErrorCode`]) || "-"}
        />
        <Result
          label="Codigo Mercado Livre"
          value={single(result[`${prefix}MercadoLivreCode`]) || "-"}
        />
        <Result
          label="Erro Mercado Livre"
          value={single(result[`${prefix}MercadoLivreError`]) || "-"}
        />
        <Result
          label="Mensagem Mercado Livre"
          value={single(result[`${prefix}ErrorMessage`]) || "-"}
        />
        <Result label="Cause" value={probeCause(result[`${prefix}Cause`])} />
        <Result
          label="blocked_by"
          value={single(result[`${prefix}BlockedBy`]) || "-"}
        />
        <Result
          label="Classificacao do 403"
          value={single(result[`${prefix}ForbiddenClassification`]) || "-"}
        />
      </dl>
      {sample.length > 0 ? (
        <div className="grid gap-2">
          <div className="text-xs font-medium text-[var(--muted-foreground)]">
            Amostra
          </div>
          {sample.map((item) => (
            <div key={item.itemId} className="rounded-md border bg-white p-2">
              <div className="text-xs font-medium">{item.itemId}</div>
              {item.title ? (
                <div className="text-xs text-[var(--muted-foreground)]">
                  {item.title}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function categoryPath(category: MercadoLivreCategory | null) {
  if (!category) {
    return "-";
  }

  const path =
    category.pathFromRoot.length > 0
      ? category.pathFromRoot
      : [{ id: category.id, name: category.name }];
  return path
    .map((item) => item.name)
    .filter(Boolean)
    .join(" > ");
}

async function categoryDetailsFor(
  categoryId: string,
  connector: Awaited<ReturnType<typeof createMercadoLivreConnector>>,
) {
  return connector.getCategory(categoryId).catch(() => null);
}

export default async function MercadoLivreIntegrationPage({
  searchParams,
}: MercadoLivrePageProps) {
  const params = await searchParams;
  const message = messageText(params?.message);
  const selectedCategoryId = single(params?.categoryId);
  const [account, config, latestImportJob] = await Promise.all([
    prisma.marketplaceAccount.findFirst({
      where: { marketplace: "MERCADO_LIVRE", enabled: true },
      orderBy: { updatedAt: "desc" },
      select: {
        status: true,
        siteId: true,
        mercadoLivreAffiliateSession: {
          select: {
            affiliateTag: true,
            availableTags: true,
            status: true,
            lastValidatedAt: true,
            lastCookieUpdateAt: true,
            lastError: true,
          },
        },
      },
    }),
    prisma.mercadoLivreDiscoveryConfig.findFirst({
      orderBy: { updatedAt: "desc" },
      select: {
        enabled: true,
        siteId: true,
        categoryIds: true,
        bestSellersEnabled: true,
        minimumPrice: true,
        maximumPrice: true,
        minimumDiscountPercentage: true,
        minimumScore: true,
        maxCandidatesPerCategory: true,
        refreshIntervalMinutes: true,
        lastRunAt: true,
        lastRunSummary: true,
      },
    }),
    prisma.importJob.findFirst({
      where: { marketplace: "MERCADO_LIVRE" },
      orderBy: { createdAt: "desc" },
      select: {
        categoryId: true,
        status: true,
        totalFound: true,
        totalResolved: true,
        totalLinksGenerated: true,
        totalReadyToPublish: true,
        totalReadyForAffiliateLink: true,
        totalIneligible: true,
        totalCreated: true,
        totalUpdated: true,
        totalInvalidLinks: true,
        totalNotFound: true,
        totalFailed: true,
        startedAt: true,
        finishedAt: true,
        errorMessage: true,
        createdAt: true,
        items: {
          where: { status: { not: "SUCCEEDED" } },
          orderBy: { createdAt: "desc" },
          take: 20,
          select: {
            position: true,
            sourceId: true,
            sourceType: true,
            stage: true,
            status: true,
            errorCode: true,
            errorMessage: true,
            attempts: true,
          },
        },
      },
    }),
  ]);
  const affiliateSession = account?.mercadoLivreAffiliateSession ?? null;
  const affiliateTags = parseMercadoLivreAffiliateTags(
    affiliateSession?.availableTags,
  );
  const affiliateSessionConfigured = Boolean(
    affiliateSession &&
    (affiliateSession.status !== "NOT_CONFIGURED" ||
      affiliateSession.lastCookieUpdateAt),
  );
  const selectedAffiliateTag = affiliateSession?.affiliateTag ?? "";
  const affiliateLastValidatedAt = affiliateSession?.lastValidatedAt ?? null;
  const affiliateLastCookieUpdateAt =
    affiliateSession?.lastCookieUpdateAt ?? null;
  const categoryIds = jsonStringArray(config?.categoryIds);
  const metrics = lastRunMetrics(config?.lastRunSummary);
  const metricGroups = lastRunObjectMetrics(config?.lastRunSummary);
  const importJobMetrics = latestImportJob
    ? [
        ["Encontrados", latestImportJob.totalFound],
        ["Resolvidos", latestImportJob.totalResolved],
        ["Links gerados", latestImportJob.totalLinksGenerated],
        ["Prontos para publicar", latestImportJob.totalReadyToPublish],
        ["Pendentes de link", latestImportJob.totalReadyForAffiliateLink],
        ["Não elegíveis", latestImportJob.totalIneligible],
        ["Criados", latestImportJob.totalCreated],
        ["Atualizados", latestImportJob.totalUpdated],
        ["Links inválidos", latestImportJob.totalInvalidLinks],
        ["Não encontrados", latestImportJob.totalNotFound],
        ["Falhas", latestImportJob.totalFailed],
      ]
    : [];
  const connector =
    account?.status === "CONNECTED"
      ? await createMercadoLivreConnector().catch(() => null)
      : null;
  const selectedCategory =
    connector && selectedCategoryId
      ? await categoryDetailsFor(selectedCategoryId, connector)
      : null;
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
  const testResult =
    single(params?.message) === "category-tested" ? params : null;
  const categorySearchResult =
    single(params?.message) === "category-search-tested" ? params : null;
  const showAffiliateSession = true;
  const generatedAffiliateUrl = single(params?.generatedAffiliateUrl);
  const affiliateEndpointMode = single(params?.affiliateEndpointMode);
  const generatedAt = single(params?.generatedAt);

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
          <Button
            type="submit"
            variant="outline"
            disabled={account?.status !== "CONNECTED"}
          >
            <RefreshCw aria-hidden="true" size={16} />
            Importar mais vendidos e gerar links
          </Button>
        </form>
      </div>

      {message ? (
        <div className="rounded-md border bg-white px-4 py-3 text-sm">
          {message}
        </div>
      ) : null}

      {showAffiliateSession ? (
        <Card>
          <CardHeader>
            <CardTitle>Sessão de afiliado Mercado Livre</CardTitle>
            <div className="grid gap-2 text-sm text-[var(--muted-foreground)] md:grid-cols-2">
              <p className="rounded-md border bg-[var(--background)] p-3">
                <span className="font-medium text-[var(--foreground)]">
                  OAuth:
                </span>{" "}
                categorias, ranking e dados dos produtos.
              </p>
              <p className="rounded-md border bg-[var(--background)] p-3">
                <span className="font-medium text-[var(--foreground)]">
                  Cookie:
                </span>{" "}
                Portal de Afiliados e geração dos links meli.la.
              </p>
            </div>
          </CardHeader>
          <CardContent className="grid gap-6">
            <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <SessionResult
                label="Status da sessão"
                value={affiliateSessionStatusLabel(affiliateSession?.status)}
              />
              <SessionResult
                label="Cookie"
                value={
                  affiliateSessionConfigured
                    ? "Cookie configurado"
                    : "Não configurado"
                }
              />
              <SessionResult
                label="Tag selecionada"
                value={affiliateSession?.affiliateTag ?? "-"}
              />
              <SessionResult
                label="Quantidade de tags encontradas"
                value={String(affiliateTags.length)}
              />
              <SessionResult
                label="Última validação"
                value={
                  affiliateLastValidatedAt
                    ? formatDateTime(affiliateLastValidatedAt)
                    : "-"
                }
              />
              <SessionResult
                label="Última atualização do cookie"
                value={
                  affiliateLastCookieUpdateAt
                    ? formatDateTime(affiliateLastCookieUpdateAt)
                    : "-"
                }
              />
              <SessionResult
                label="Status OAuth separado"
                value={account?.status ?? "DISCONNECTED"}
              />
              <SessionResult
                label="Último erro"
                value={affiliateSession?.lastError ?? "-"}
              />
            </dl>

            {!account ? (
              <div className="rounded-md border bg-[var(--background)] p-3 text-sm">
                Conecte o OAuth do Mercado Livre antes de configurar a sessão de
                afiliado.
              </div>
            ) : null}

            <form
              action={saveMercadoLivreAffiliateSessionAction}
              className="grid gap-4"
            >
              <div className="grid gap-4 lg:grid-cols-2">
                <Field label="Link de afiliado de referência">
                  <Input
                    name="sampleAffiliateLink"
                    type="url"
                    defaultValue=""
                    placeholder="https://meli.la/..."
                    autoComplete="off"
                  />
                  <p className="text-xs text-[var(--muted-foreground)]">
                    Usado apenas para validar o fluxo da sua conta. O sistema
                    não fabrica links a partir desta referência.
                  </p>
                </Field>

                <Field label="Tag de afiliado">
                  <Select
                    name="affiliateTag"
                    defaultValue={selectedAffiliateTag}
                  >
                    <option value="">Selecionar automaticamente</option>
                    {selectedAffiliateTag &&
                    !affiliateTags.some(
                      (tag) => tag.value === selectedAffiliateTag,
                    ) ? (
                      <option value={selectedAffiliateTag}>
                        {selectedAffiliateTag}
                      </option>
                    ) : null}
                    {affiliateTags.map((tag) => (
                      <option key={tag.value} value={tag.value}>
                        {tag.label}
                        {tag.isDefault ? " (padrão)" : ""}
                      </option>
                    ))}
                  </Select>
                  <p className="text-xs text-[var(--muted-foreground)]">
                    Depois da primeira validação, todas as tags encontradas
                    ficam disponíveis aqui.
                  </p>
                </Field>
              </div>

              <Field label="Cookie completo do Mercado Livre">
                <Textarea
                  name="cookie"
                  defaultValue=""
                  placeholder={
                    affiliateSessionConfigured
                      ? "Cookie configurado. Cole aqui somente para substituir."
                      : "cookie1=valor1; cookie2=valor2"
                  }
                  autoComplete="off"
                  spellCheck={false}
                  rows={5}
                />
                <p className="text-xs text-[var(--muted-foreground)]">
                  O valor salvo nunca é exibido. Deixe vazio para preservar o
                  cookie atual; cole um novo valor para substituí-lo.
                </p>
              </Field>

              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={!account}>
                  Salvar e testar
                </Button>
                <Button
                  type="submit"
                  variant="outline"
                  formAction={selectMercadoLivreAffiliateTagAction}
                  disabled={!account || affiliateTags.length === 0}
                >
                  Atualizar tag
                </Button>
              </div>
            </form>

            <form
              action={generateMercadoLivreAffiliateTestLinkAction}
              className="grid gap-4 border-t pt-4"
            >
              <div className="grid gap-4 lg:grid-cols-2">
                <Field label="URL publica do produto para teste">
                  <Input
                    name="productUrl"
                    type="url"
                    placeholder="https://produto.mercadolivre.com.br/MLB-..."
                    autoComplete="off"
                    required
                  />
                </Field>
                <Field label="Tag para o teste">
                  <Select
                    name="affiliateTag"
                    defaultValue={selectedAffiliateTag}
                  >
                    <option value="">Usar tag selecionada</option>
                    {affiliateTags.map((tag) => (
                      <option key={tag.value} value={tag.value}>
                        {tag.label}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <Button
                type="submit"
                variant="outline"
                className="w-fit"
                disabled={affiliateSession?.status !== "CONNECTED"}
              >
                Gerar link meli.la de teste
              </Button>
            </form>

            {generatedAffiliateUrl ? (
              <div className="grid gap-2 rounded-md border bg-[var(--background)] p-3 text-sm">
                <p>
                  <span className="font-medium">Link gerado:</span>{" "}
                  <a
                    href={generatedAffiliateUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="break-all underline"
                  >
                    {generatedAffiliateUrl}
                  </a>
                </p>
                <p>Modo: {affiliateEndpointMode ?? "stripe_v2"}</p>
                <p>
                  Horario:{" "}
                  {generatedAt ? formatDateTime(new Date(generatedAt)) : "-"}
                </p>
              </div>
            ) : null}

            <div className="flex flex-wrap gap-2 border-t pt-4">
              <form action={testMercadoLivreAffiliateSessionAction}>
                <Button
                  type="submit"
                  variant="outline"
                  disabled={!affiliateSessionConfigured}
                >
                  Testar conexão
                </Button>
              </form>
              <form action={clearMercadoLivreAffiliateSessionAction}>
                <Button
                  type="submit"
                  variant="outline"
                  disabled={!affiliateSession}
                >
                  Limpar sessão
                </Button>
              </form>
              <form action={generatePendingMercadoLivreAffiliateLinksAction}>
                <input name="limit" type="hidden" value="50" />
                <Button
                  type="submit"
                  variant="outline"
                  disabled={affiliateSession?.status !== "CONNECTED"}
                >
                  Gerar links pendentes
                </Button>
              </form>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Links de afiliado</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm">
            <p>
              Gere os links no Portal oficial do Mercado Livre. O fluxo de
              descoberta termina em READY_FOR_AFFILIATE_LINK e não usa a URL
              original como fallback.
            </p>
            <Button asChild className="w-fit">
              <Link href="/ofertas/affiliate-links">
                Abrir ofertas pendentes de link
              </Link>
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Fluxo de importação dos mais vendidos</CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="grid gap-3 text-sm md:grid-cols-2 lg:grid-cols-4">
            {[
              ["1", "Conectar OAuth", "Categorias, ranking e produtos."],
              ["2", "Selecionar categoria", "Escolha uma categoria folha."],
              [
                "3",
                "Importar mais vendidos",
                "Highlights oficiais resolvem ITEM, PRODUCT e USER_PRODUCT.",
              ],
              [
                "4",
                "Importar links",
                "Cole meli.la na tela de ofertas pendentes.",
              ],
            ].map(([step, title, description]) => (
              <li
                key={step}
                className="grid gap-1 rounded-md border bg-[var(--background)] p-3"
              >
                <span className="text-xs font-semibold text-[var(--muted-foreground)]">
                  Etapa {step}
                </span>
                <span className="font-medium">{title}</span>
                <span className="text-xs text-[var(--muted-foreground)]">
                  {description}
                </span>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Discovery</CardTitle>
          </CardHeader>
          <CardContent>
            <form action={saveMercadoLivreConfigAction} className="grid gap-4">
              <label className="flex items-center gap-2 text-sm">
                <input
                  name="enabled"
                  type="checkbox"
                  defaultChecked={config?.enabled ?? false}
                />
                Integracao ativa
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  name="bestSellersEnabled"
                  type="checkbox"
                  defaultChecked={config?.bestSellersEnabled ?? true}
                />
                Usar ranking oficial de mais vendidos
              </label>

              <div className="grid gap-4 md:grid-cols-2">
                <Field label="Site ID">
                  <Input
                    name="siteId"
                    defaultValue={config?.siteId ?? account?.siteId ?? "MLB"}
                  />
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
                  <Input
                    name="minimumPrice"
                    inputMode="decimal"
                    defaultValue={config?.minimumPrice?.toString() ?? ""}
                  />
                </Field>
                <Field label="Preco maximo">
                  <Input
                    name="maximumPrice"
                    inputMode="decimal"
                    defaultValue={config?.maximumPrice?.toString() ?? ""}
                  />
                </Field>
                <Field label="Desconto minimo (%)">
                  <Input
                    name="minimumDiscountPercentage"
                    inputMode="decimal"
                    defaultValue={
                      config?.minimumDiscountPercentage?.toString() ?? ""
                    }
                  />
                </Field>
                <Field label="Score minimo">
                  <Input
                    name="minimumScore"
                    type="number"
                    min={0}
                    max={100}
                    defaultValue={config?.minimumScore ?? 0}
                  />
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
                  Opcional para ajuste manual. Ao salvar, cada ID e validado no
                  Mercado Livre. Para ranking de mais vendidos, use categorias
                  folha.
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
            <CardTitle>Última importação</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 text-sm">
            <div className="grid gap-1">
              <span className="text-[var(--muted-foreground)]">Conta</span>
              <span>{account?.status ?? "DISCONNECTED"}</span>
            </div>
            {latestImportJob ? (
              <>
                <dl className="grid gap-3 sm:grid-cols-3">
                  <div className="grid gap-1">
                    <dt className="text-[var(--muted-foreground)]">Status</dt>
                    <dd>{importJobStatusLabel(latestImportJob.status)}</dd>
                  </div>
                  <div className="grid gap-1">
                    <dt className="text-[var(--muted-foreground)]">
                      Categoria
                    </dt>
                    <dd>{latestImportJob.categoryId ?? "-"}</dd>
                  </div>
                  <div className="grid gap-1">
                    <dt className="text-[var(--muted-foreground)]">
                      Atualização
                    </dt>
                    <dd>
                      {formatDateTime(
                        latestImportJob.finishedAt ??
                          latestImportJob.startedAt ??
                          latestImportJob.createdAt,
                      )}
                    </dd>
                  </div>
                </dl>

                {latestImportJob.errorMessage ? (
                  <div className="rounded-md border bg-[var(--background)] p-3">
                    <div className="text-xs text-[var(--muted-foreground)]">
                      Erro da execução
                    </div>
                    <div className="mt-1 break-words">
                      {sanitizedImportError(latestImportJob.errorMessage)}
                    </div>
                  </div>
                ) : null}

                <dl className="grid grid-cols-2 gap-3">
                  {importJobMetrics.map(([label, value]) => (
                    <div
                      key={label}
                      className="rounded-md border bg-[var(--background)] p-3"
                    >
                      <dt className="text-xs text-[var(--muted-foreground)]">
                        {label}
                      </dt>
                      <dd className="text-lg font-semibold">{value}</dd>
                    </div>
                  ))}
                </dl>

                {latestImportJob.items.length > 0 ? (
                  <div className="grid gap-3 border-t pt-4">
                    <div>
                      <div className="font-medium">
                        Diagnósticos por produto
                      </div>
                      <p className="text-xs text-[var(--muted-foreground)]">
                        Até 20 itens não concluídos da última importação.
                      </p>
                    </div>
                    <div className="grid max-h-[480px] gap-2 overflow-y-auto pr-1">
                      {latestImportJob.items.map((item, index) => (
                        <div
                          key={`${item.sourceType ?? "source"}-${item.sourceId ?? "unknown"}-${item.stage}-${index}`}
                          className="grid gap-2 rounded-md border bg-[var(--background)] p-3"
                        >
                          <dl className="grid gap-2 sm:grid-cols-2">
                            <Result
                              label="Posição"
                              value={
                                item.position === null
                                  ? "-"
                                  : String(item.position)
                              }
                            />
                            <Result
                              label="Origem"
                              value={`${item.sourceType ?? "-"} · ${item.sourceId ?? "-"}`}
                            />
                            <Result
                              label="Etapa / status"
                              value={`${item.stage} · ${item.status}`}
                            />
                            <Result
                              label="Tentativas"
                              value={String(item.attempts)}
                            />
                            <Result
                              label="Código"
                              value={item.errorCode ?? "-"}
                            />
                          </dl>
                          <div className="grid gap-1">
                            <div className="text-xs text-[var(--muted-foreground)]">
                              Mensagem
                            </div>
                            <div className="break-words">
                              {sanitizedImportError(item.errorMessage)}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </>
            ) : metrics.length === 0 ? (
              <EmptyState
                title="Sem execuções registradas"
                description="Execute uma importação manual ou aguarde o worker coletar candidatos."
              />
            ) : (
              <div className="grid gap-3">
                <div className="grid gap-1">
                  <span className="text-[var(--muted-foreground)]">
                    Última sincronização
                  </span>
                  <span>
                    {config?.lastRunAt ? formatDateTime(config.lastRunAt) : "-"}
                  </span>
                </div>
                <dl className="grid grid-cols-2 gap-3">
                  {metrics.map(([key, value]) => (
                    <div
                      key={key}
                      className="rounded-md border bg-[var(--background)] p-3"
                    >
                      <dt className="text-xs text-[var(--muted-foreground)]">
                        {key}
                      </dt>
                      <dd className="text-lg font-semibold">{String(value)}</dd>
                    </div>
                  ))}
                </dl>
                {metricGroups.map(([group, entries]) => (
                  <div
                    key={group}
                    className="rounded-md border bg-[var(--background)] p-3"
                  >
                    <div className="text-xs font-medium text-[var(--muted-foreground)]">
                      {group}
                    </div>
                    <dl className="mt-2 grid gap-1">
                      {entries.map(([key, value]) => (
                        <div
                          key={key}
                          className="flex items-center justify-between gap-3"
                        >
                          <dt className="truncate text-xs">{key}</dt>
                          <dd className="text-sm font-semibold">
                            {String(value)}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                ))}
              </div>
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
                  <div className="text-xs text-[var(--muted-foreground)]">
                    Caminho atual
                  </div>
                  <div className="mt-1 font-medium">
                    {selectedCategory
                      ? categoryPath(selectedCategory)
                      : "Categorias principais MLB"}
                  </div>
                  {selectedCategory ? (
                    <div className="mt-1 text-xs text-[var(--muted-foreground)]">
                      {selectedCategory.id}
                    </div>
                  ) : null}
                </div>

                {selectedCategory ? (
                  <div className="flex flex-wrap gap-2">
                    <Button asChild variant="outline">
                      <Link href="/integracoes/mercado-livre">
                        Voltar para categorias principais
                      </Link>
                    </Button>
                    {selectedCategory.pathFromRoot.length > 1 ? (
                      <Button asChild variant="outline">
                        <Link
                          href={`/integracoes/mercado-livre?categoryId=${encodeURIComponent(
                            selectedCategory.pathFromRoot[
                              selectedCategory.pathFromRoot.length - 2
                            ]?.id ?? "",
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
                        <div
                          key={summary.id}
                          className="grid gap-3 rounded-md border bg-white p-4 md:grid-cols-[1fr_auto]"
                        >
                          <div>
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-medium">
                                {details?.name ?? summary.name}
                              </span>
                              <span className="rounded-md border bg-[var(--background)] px-2 py-1 text-xs">
                                {isLeaf ? "CATEGORIA FOLHA" : "CATEGORIA"}
                              </span>
                            </div>
                            <div className="mt-1 text-xs text-[var(--muted-foreground)]">
                              {details ? categoryPath(details) : summary.name}
                            </div>
                            <div className="mt-1 text-xs text-[var(--muted-foreground)]">
                              {summary.id}
                            </div>
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            {isLeaf ? (
                              <form action={addMercadoLivreCategoryAction}>
                                <input
                                  name="categoryId"
                                  type="hidden"
                                  value={summary.id}
                                />
                                <Button type="submit" variant="outline">
                                  <Plus aria-hidden="true" size={16} />
                                  Adicionar
                                </Button>
                              </form>
                            ) : (
                              <Button asChild variant="outline">
                                <Link
                                  href={`/integracoes/mercado-livre?categoryId=${encodeURIComponent(summary.id)}`}
                                >
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
            <form
              action={testMercadoLivreCategoryAction}
              className="grid gap-3"
            >
              <Field label="ID da categoria">
                <Input
                  name="categoryId"
                  defaultValue={
                    selectedCategory?.id ?? selectedCategoryId ?? ""
                  }
                  placeholder="MLB123456"
                />
              </Field>
              <Button type="submit" variant="outline" disabled={!connector}>
                <Search aria-hidden="true" size={16} />
                Testar categoria
              </Button>
            </form>

            {testResult ? (
              <dl className="grid gap-2 rounded-md border bg-[var(--background)] p-3">
                <Result
                  label="Nome"
                  value={single(testResult.categoryName) ?? "-"}
                />
                <Result
                  label="ID"
                  value={single(testResult.categoryId) ?? "-"}
                />
                <Result
                  label="Caminho"
                  value={single(testResult.categoryPath) ?? "-"}
                />
                <Result
                  label="Categoria folha"
                  value={
                    single(testResult.categoryLeaf) === "true" ? "sim" : "nao"
                  }
                />
                <Result
                  label="Subcategorias"
                  value={single(testResult.categoryChildrenCount) ?? "0"}
                />
                <Result
                  label="Highlights disponiveis"
                  value={
                    single(testResult.highlightsAvailable) === "true"
                      ? "sim"
                      : "nao"
                  }
                />
                <Result
                  label="Candidatos encontrados"
                  value={single(testResult.candidatesFound) ?? "0"}
                />
                <Result
                  label="ITEM"
                  value={single(testResult.highlightItemCount) ?? "0"}
                />
                <Result
                  label="PRODUCT"
                  value={single(testResult.highlightProductCount) ?? "0"}
                />
                <Result
                  label="USER_PRODUCT"
                  value={single(testResult.highlightUserProductCount) ?? "0"}
                />
                <Result
                  label="Tipo desconhecido"
                  value={single(testResult.highlightUnknownTypeCount) ?? "0"}
                />
                <Result
                  label="PRODUCTS encontrados"
                  value={single(testResult.highlightProductCount) ?? "0"}
                />
                <Result
                  label="Com winner direto"
                  value={single(testResult.productResolvedDirectly) ?? "0"}
                />
                <Result
                  label="Produtos pai"
                  value={single(testResult.productParentCount) ?? "0"}
                />
                <Result
                  label="Resolvidos via filho"
                  value={single(testResult.productResolvedViaChild) ?? "0"}
                />
                <Result
                  label="Terminais sem winner"
                  value={single(testResult.productLeafWithoutWinner) ?? "0"}
                />
                <Result
                  label="Pais sem filho resolvivel"
                  value={
                    single(testResult.productParentWithoutResolvableChild) ??
                    "0"
                  }
                />
                <Result
                  label="Resolvidos para item"
                  value={single(testResult.resolvedItemCandidates) ?? "0"}
                />
                <Result
                  label="Nao resolvidos"
                  value={single(testResult.unresolvedCandidates) ?? "0"}
                />
                <Result
                  label="Motivos de descarte"
                  value={single(testResult.resolutionReasons) || "-"}
                />
                <Result
                  label="Motivo highlights"
                  value={single(testResult.highlightsReason) ?? "-"}
                />
              </dl>
            ) : null}

            <div className="grid gap-2">
              <div className="font-medium">Categorias configuradas</div>
              {configuredCategories.length === 0 ? (
                <p className="text-[var(--muted-foreground)]">
                  Nenhuma categoria configurada.
                </p>
              ) : (
                <div className="grid gap-2">
                  {configuredCategories.map((category) => (
                    <div
                      key={category.id}
                      className="rounded-md border bg-white p-3"
                    >
                      <div className="font-medium">
                        {category.details?.name ?? category.id}
                      </div>
                      <div className="text-xs text-[var(--muted-foreground)]">
                        {category.details
                          ? categoryPath(category.details)
                          : "Detalhes indisponiveis"}
                      </div>
                      <div className="text-xs text-[var(--muted-foreground)]">
                        {category.id}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <details
              className="rounded-md border bg-[var(--background)] p-3"
              open={Boolean(categorySearchResult)}
            >
              <summary className="cursor-pointer font-medium">
                Diagnóstico avançado: busca comum por categoria
              </summary>
              <div className="mt-3 grid gap-3">
                <p className="text-xs text-[var(--muted-foreground)]">
                  Este probe não faz parte da importação normal. O fluxo
                  principal usa o ranking oficial de highlights em categorias
                  folha.
                </p>
                <form
                  action={probeMercadoLivreCategorySearchAction}
                  className="grid gap-3"
                >
                  <input
                    name="categoryId"
                    type="hidden"
                    value={selectedCategory?.id ?? selectedCategoryId ?? ""}
                  />
                  <Button
                    type="submit"
                    variant="outline"
                    disabled={
                      !connector ||
                      !selectedCategory ||
                      selectedCategory.children.length > 0
                    }
                  >
                    <Search aria-hidden="true" size={16} />
                    Executar probe avançado
                  </Button>
                </form>

                {categorySearchResult ? (
                  <div className="grid gap-3 rounded-md border bg-white p-3">
                    <dl className="grid gap-2">
                      <Result
                        label="Categoria"
                        value={
                          single(categorySearchResult.probeCategoryName) ?? "-"
                        }
                      />
                      <Result
                        label="ID"
                        value={single(categorySearchResult.categoryId) ?? "-"}
                      />
                      <Result
                        label="Caminho"
                        value={
                          single(categorySearchResult.probeCategoryPath) ?? "-"
                        }
                      />
                      <Result
                        label="Endpoint logico"
                        value={`${single(categorySearchResult.probeMethod) ?? "GET"} ${single(categorySearchResult.probeEndpoint) ?? "-"}`}
                      />
                      <Result
                        label="Parametro category"
                        value={
                          single(categorySearchResult.probeCategoryParameter) ??
                          "-"
                        }
                      />
                      <Result
                        label="Parametro limit"
                        value={
                          single(categorySearchResult.probeLimitParameter) ??
                          "-"
                        }
                      />
                      <Result
                        label="Diagnostico"
                        value={
                          single(categorySearchResult.probeDiagnosis) ||
                          "SEM_CLASSIFICACAO_403"
                        }
                      />
                    </dl>
                    <CategorySearchAttempt
                      label="Tentativa autenticada"
                      prefix="probeAuthenticated"
                      result={categorySearchResult}
                    />
                    <CategorySearchAttempt
                      label="Tentativa publica"
                      prefix="probePublic"
                      result={categorySearchResult}
                    />
                  </div>
                ) : null}
              </div>
            </details>
          </CardContent>
        </Card>
      </div>
    </AdminShell>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
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

function SessionResult({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1 rounded-md border bg-[var(--background)] p-3">
      <dt className="text-xs text-[var(--muted-foreground)]">{label}</dt>
      <dd className="break-words text-sm font-medium">{value}</dd>
    </div>
  );
}
