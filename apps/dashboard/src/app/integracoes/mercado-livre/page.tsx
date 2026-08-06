import { ArrowLeft, Plus, Save, Search } from "lucide-react";
import Link from "next/link";
import { prisma, type Prisma } from "@affiliate/database";
import {
  createMercadoLivreConnector,
  parseMercadoLivreAffiliateTags,
  type MercadoLivreCategory,
} from "@affiliate/marketplace-connectors";
import {
  normalizeMultiCategorySettings,
  resolveMultiCategoryRuntimeConfig,
  selectBalancedMultiCategoryOffers,
} from "@affiliate/marketplace-discovery";
import { AdminShell } from "@/components/admin-shell";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Alert } from "@/components/ui/alert";
import { StatusBadge } from "@/components/ui/status-badge";
import { PageTabs } from "@/components/ui/tabs";
import {
  addMercadoLivreCategoryAction,
  diagnoseMercadoLivreProductAction,
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
  testMercadoLivreProductPdpAffiliateLinkAction,
  testMercadoLivreAffiliateSessionAction,
} from "@/lib/mercadolivre-affiliate-actions";
import { MercadoLivreImportButton } from "./mercado-livre-import-button";
import {
  affiliateSessionStatusLabel,
  importJobStatusLabel,
  jsonStringArray,
  lastRunMetrics,
  lastRunObjectMetrics,
  messageText,
  multiCategoryRunSummary,
  probeCause,
  probeSample,
  productProbeRejectionReasons,
  productProbeSamples,
  sanitizedImportError,
  single,
} from "./mercado-livre-view-model";

export const dynamic = "force-dynamic";

type MercadoLivrePageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

type SearchParamRecord = Record<string, string | string[] | undefined>;

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
          label="Modo de autenticação"
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
          label="Classificação do 403"
          value={single(result[`${prefix}ForbiddenClassification`]) || "-"}
        />
      </dl>
      {sample.length > 0 ? (
        <div className="grid gap-2">
          <div className="text-xs font-medium text-[var(--muted-foreground)]">
            Amostra
          </div>
          {sample.map((item) => (
            <div
              key={item.itemId}
              className="rounded-md border bg-[var(--surface)] p-2"
            >
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
  const sessionFilter = single(params?.sessionFilter);
  const categoryFilter = single(params?.categoryFilter);
  const statusFilter = single(params?.statusFilter);
  const dateFilter = single(params?.dateFilter);
  const importJobWhere: Prisma.ImportJobWhereInput = {
    marketplace: "MERCADO_LIVRE",
    ...(sessionFilter ? { id: sessionFilter } : {}),
    ...(categoryFilter ? { categoryId: categoryFilter } : {}),
    ...([
      "QUEUED",
      "RUNNING",
      "SUCCEEDED",
      "SUCCEEDED_WITH_ERRORS",
      "FAILED",
      "DUPLICATE",
    ].includes(statusFilter ?? "")
      ? { status: statusFilter as Prisma.EnumImportJobStatusFilter }
      : {}),
    ...(dateFilter && !Number.isNaN(Date.parse(`${dateFilter}T00:00:00Z`))
      ? { createdAt: { gte: new Date(`${dateFilter}T00:00:00Z`) } }
      : {}),
  };
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
        multiCategoryEnabled: true,
        multiCategorySettings: true,
        multiCategoryMinOffersPerCategory: true,
        multiCategoryMaxOffersPerCategory: true,
        multiCategoryMaxTotalPerSession: true,
        multiCategorySelectionMode: true,
        multiCategoryAllowCategoryBackfill: true,
      },
    }),
    prisma.importJob.findFirst({
      where: importJobWhere,
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
        summary: true,
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
  const multiCategorySettings = normalizeMultiCategorySettings(
    categoryIds,
    config?.multiCategorySettings,
  );
  const multiCategorySettingsById = new Map(
    multiCategorySettings.map((setting) => [setting.categoryId, setting]),
  );
  const multiCategoryRuntime = resolveMultiCategoryRuntimeConfig(process.env, {
    enabled: config?.multiCategoryEnabled ?? false,
    minOffersPerCategory: config?.multiCategoryMinOffersPerCategory ?? 1,
    maxOffersPerCategory: config?.multiCategoryMaxOffersPerCategory ?? 2,
    maxTotalPerSession: config?.multiCategoryMaxTotalPerSession ?? 12,
    selectionMode: config?.multiCategorySelectionMode ?? "ROUND_ROBIN",
    allowCategoryBackfill: config?.multiCategoryAllowCategoryBackfill ?? false,
  });
  const previewOffers =
    categoryIds.length > 0
      ? await prisma.offer.findMany({
          where: {
            marketplace: "MERCADO_LIVRE",
            sourceCategoryId: { in: categoryIds },
            status: {
              in: [
                "READY_TO_PUBLISH",
                "READY_FOR_AFFILIATE_LINK",
                "SCHEDULED",
                "PUBLISHED",
              ],
            },
          },
          orderBy: { collectedAt: "desc" },
          take: 200,
          select: {
            id: true,
            productId: true,
            externalProductId: true,
            sourceCategoryId: true,
            score: true,
            bestSellerPosition: true,
            discountPercentage: true,
            scoreCompletenessPercentage: true,
            affiliateUrl: true,
            status: true,
          },
        })
      : [];
  const previewSelection = selectBalancedMultiCategoryOffers({
    settings: multiCategorySettings,
    config: multiCategoryRuntime,
    candidates: previewOffers.flatMap((offer) =>
      offer.sourceCategoryId
        ? [
            {
              offerId: offer.id,
              productId: offer.productId ?? offer.externalProductId,
              sourceCategoryIds: [offer.sourceCategoryId],
              score: offer.score,
              bestSellerPosition: offer.bestSellerPosition,
              discountPercentage:
                offer.discountPercentage === null
                  ? null
                  : Number(offer.discountPercentage),
              completenessPercentage:
                offer.scoreCompletenessPercentage === null
                  ? null
                  : Number(offer.scoreCompletenessPercentage),
              eligible:
                Boolean(offer.affiliateUrl) &&
                ["READY_TO_PUBLISH", "SCHEDULED", "PUBLISHED"].includes(
                  offer.status,
                ),
              rejectionReason: offer.affiliateUrl
                ? offer.status
                : "AFFILIATE_LINK_REQUIRED",
            },
          ]
        : [],
    ),
  });
  const metrics = lastRunMetrics(config?.lastRunSummary);
  const metricGroups = lastRunObjectMetrics(config?.lastRunSummary);
  const multiCategorySummary =
    multiCategoryRunSummary(latestImportJob?.summary) ??
    multiCategoryRunSummary(config?.lastRunSummary);
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
  const configuredCategoryIds = new Set(categoryIds);
  const testResult =
    single(params?.message) === "category-tested" ? params : null;
  const categorySearchResult =
    single(params?.message) === "category-search-tested" ? params : null;
  const productProbeResult =
    single(params?.message) === "product-diagnosed" ? params : null;
  const productPdpAffiliateResult =
    single(params?.message) === "product-pdp-affiliate-tested" ? params : null;
  const productProbeReasons = productProbeRejectionReasons(
    productProbeResult?.rejectionReasons,
  );
  const productProbeDiagnosticSamples = productProbeSamples(
    productProbeResult?.diagnosticSamples,
  );
  const showAffiliateSession = true;
  const generatedAffiliateUrl = single(params?.generatedAffiliateUrl);
  const affiliateEndpointMode = single(params?.affiliateEndpointMode);
  const generatedAt = single(params?.generatedAt);
  const testedCategoryId = single(testResult?.categoryId);
  const testedCategoryIsLeaf = single(testResult?.categoryLeaf) === "true";
  const testedCategoryAlreadyConfigured = Boolean(
    testedCategoryId && configuredCategoryIds.has(testedCategoryId),
  );

  return (
    <AdminShell currentPath="/integracoes/mercado-livre" title="Mercado Livre">
      <div className="flex flex-wrap gap-2">
        <Button asChild variant="outline">
          <Link href="/integracoes">
            <ArrowLeft aria-hidden="true" size={16} />
            Integrações
          </Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/api/integrations/mercadolivre/connect">
            {account?.status === "CONNECTED" ? "Reconectar" : "Conectar"}
          </Link>
        </Button>
        <form action={syncMercadoLivreNowAction}>
          <MercadoLivreImportButton
            disabled={account?.status !== "CONNECTED"}
          />
        </form>
      </div>

      {message ? (
        <Alert
          tone={
            /falha|erro|inválid|expir/i.test(message)
              ? "danger"
              : /aten|pendente/i.test(message)
                ? "warning"
                : "success"
          }
          live
        >
          {message}
        </Alert>
      ) : null}

      <PageTabs
        label="Seções da integração Mercado Livre"
        items={[
          { label: "Visão geral", href: "#visao-geral", active: true },
          { label: "Descoberta", href: "#descoberta" },
          { label: "Categorias", href: "#categorias" },
          { label: "Links afiliados", href: "#links-afiliados" },
          { label: "Histórico", href: "#historico" },
          { label: "Diagnósticos", href: "#diagnosticos" },
        ]}
      />

      {showAffiliateSession ? (
        <Card id="links-afiliados" className="scroll-mt-24">
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

            <details className="rounded-[var(--radius-md)] border bg-[var(--background)] px-4">
              <summary className="cursor-pointer font-semibold">
                Configuração avançada da sessão
              </summary>
              <form
                action={saveMercadoLivreAffiliateSessionAction}
                className="grid gap-4 border-t py-4"
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
            </details>

            <form
              action={generateMercadoLivreAffiliateTestLinkAction}
              className="grid gap-4 border-t pt-4"
            >
              <div className="grid gap-4 lg:grid-cols-2">
                <Field label="URL pública do produto para teste">
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
                  Horário:{" "}
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

      <Card id="visao-geral" className="scroll-mt-24">
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
                "Gerar ou importar links",
                "A sessão conectada gera meli.la; o lote manual permanece como fallback.",
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

      <Card>
        <CardHeader>
          <CardTitle>Preview multicategoria somente leitura</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm">
          <p className="text-[var(--muted-foreground)]">
            Usa as ofertas atuais para estimar a próxima distribuição. Não cria
            Publication, não envia mensagens e não chama integrações externas.
          </p>
          <div className="flex flex-wrap gap-2">
            <span className="rounded border px-2 py-1">
              {previewOffers.length} candidatas
            </span>
            <span className="rounded border px-2 py-1">
              {previewSelection.selected.length} selecionadas
            </span>
            <span className="rounded border px-2 py-1">
              {previewSelection.quotaNotMet} cotas não atendidas
            </span>
          </div>
          <div className="text-xs">
            {previewSelection.selected
              .map((offer, index) => `${index + 1}. ${offer.primaryCategoryId}`)
              .join(" → ") || "Nenhuma oferta elegível no estado atual."}
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
        <Card id="descoberta" className="scroll-mt-24">
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
                Integração ativa
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  name="bestSellersEnabled"
                  type="checkbox"
                  defaultChecked={config?.bestSellersEnabled ?? true}
                />
                Usar ranking oficial de mais vendidos
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  name="multiCategoryEnabled"
                  type="checkbox"
                  defaultChecked={config?.multiCategoryEnabled ?? false}
                />
                Habilitar seleção multicategoria balanceada
              </label>

              <div className="grid gap-4 md:grid-cols-2">
                <Field label="Site ID">
                  <Input
                    name="siteId"
                    defaultValue={config?.siteId ?? account?.siteId ?? "MLB"}
                  />
                </Field>
                <Field label="Máximo por categoria">
                  <Input
                    name="maxCandidatesPerCategory"
                    type="number"
                    min={1}
                    max={20}
                    defaultValue={config?.maxCandidatesPerCategory ?? 20}
                  />
                </Field>
                <Field label="Preço mínimo">
                  <Input
                    name="minimumPrice"
                    inputMode="decimal"
                    defaultValue={config?.minimumPrice?.toString() ?? ""}
                  />
                </Field>
                <Field label="Preço máximo">
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
                <Field label="Mínimo de ofertas por categoria">
                  <Input
                    name="multiCategoryMinOffersPerCategory"
                    type="number"
                    min={0}
                    max={2}
                    defaultValue={
                      config?.multiCategoryMinOffersPerCategory ?? 1
                    }
                  />
                </Field>
                <Field label="Máximo de ofertas por categoria">
                  <Input
                    name="multiCategoryMaxOffersPerCategory"
                    type="number"
                    min={1}
                    max={10}
                    defaultValue={
                      config?.multiCategoryMaxOffersPerCategory ?? 2
                    }
                  />
                </Field>
                <Field label="Máximo total por sessão">
                  <Input
                    name="multiCategoryMaxTotalPerSession"
                    type="number"
                    min={1}
                    max={100}
                    defaultValue={config?.multiCategoryMaxTotalPerSession ?? 12}
                  />
                </Field>
                <Field label="Modo de seleção">
                  <Select
                    name="multiCategorySelectionMode"
                    defaultValue={
                      config?.multiCategorySelectionMode ?? "ROUND_ROBIN"
                    }
                  >
                    <option value="ROUND_ROBIN">Round robin</option>
                  </Select>
                </Field>
              </div>

              <label className="flex items-center gap-2 text-sm">
                <input
                  name="multiCategoryAllowCategoryBackfill"
                  type="checkbox"
                  defaultChecked={
                    config?.multiCategoryAllowCategoryBackfill ?? false
                  }
                />
                Permitir backfill controlado entre categorias
              </label>

              <details className="rounded-md border bg-[var(--background)] px-4">
                <summary className="cursor-pointer font-medium">
                  Opções avançadas
                </summary>
                <div className="border-t py-4">
                  <Field label="IDs de categorias">
                    <Textarea
                      name="categoryIds"
                      defaultValue={categoryIds.join(", ")}
                      placeholder="MLB123456, MLB654321"
                    />
                    <p className="text-xs text-[var(--muted-foreground)]">
                      Ajuste manual opcional. Ao salvar, cada ID é validado no
                      Mercado Livre. Prefira o navegador de categorias abaixo.
                    </p>
                  </Field>
                </div>
              </details>

              {configuredCategories.length > 0 ? (
                <div
                  id="categorias-configuradas"
                  className="scroll-mt-24 overflow-x-auto rounded-md border"
                >
                  <table className="w-full text-left text-sm">
                    <thead className="bg-[var(--muted)]">
                      <tr>
                        <th className="p-2">Ativa</th>
                        <th className="p-2">Categoria oficial</th>
                        <th className="p-2">Prioridade</th>
                        <th className="p-2">Mínimo</th>
                        <th className="p-2">Máximo</th>
                      </tr>
                    </thead>
                    <tbody>
                      {configuredCategories.map((category) => {
                        const setting = multiCategorySettingsById.get(
                          category.id,
                        );
                        return (
                          <tr key={category.id} className="border-t">
                            <td className="p-2">
                              <input
                                aria-label={`Habilitar ${category.id}`}
                                name={`categoryEnabled:${category.id}`}
                                type="checkbox"
                                defaultChecked={setting?.enabled ?? true}
                              />
                            </td>
                            <td className="p-2">
                              <span className="font-medium">
                                {category.details?.name ??
                                  setting?.name ??
                                  category.id}
                              </span>
                              <span className="block text-xs text-[var(--muted-foreground)]">
                                {category.id} · categoria folha
                              </span>
                            </td>
                            <td className="p-2">
                              <Input
                                aria-label={`Prioridade ${category.id}`}
                                name={`categoryPriority:${category.id}`}
                                type="number"
                                min={-100}
                                max={100}
                                defaultValue={setting?.priority ?? 0}
                              />
                            </td>
                            <td className="p-2">
                              <Input
                                aria-label={`Mínimo ${category.id}`}
                                name={`categoryMin:${category.id}`}
                                type="number"
                                min={0}
                                max={2}
                                defaultValue={setting?.minOffers ?? ""}
                                placeholder="global"
                              />
                            </td>
                            <td className="p-2">
                              <Input
                                aria-label={`Máximo ${category.id}`}
                                name={`categoryMax:${category.id}`}
                                type="number"
                                min={1}
                                max={10}
                                defaultValue={setting?.maxOffers ?? ""}
                                placeholder="global"
                              />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : null}

              <Button type="submit">
                <Save aria-hidden="true" size={16} />
                Salvar configuração
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card id="diagnosticos" className="scroll-mt-24">
          <CardHeader>
            <CardTitle>Diagnosticar PRODUCT</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 text-sm">
            <p className="text-[var(--muted-foreground)]">
              Consulta o PRODUCT, interpreta os product items resumidos e
              hidrata os ITEM IDs pela API oficial. Este probe não gera meli.la,
              não ingere ofertas e não cria jobs.
            </p>
            <form
              action={diagnoseMercadoLivreProductAction}
              className="grid gap-3"
            >
              <Field label="PRODUCT ID">
                <Input
                  name="productId"
                  defaultValue={single(params?.productId) ?? ""}
                  placeholder="MLB62081577"
                />
              </Field>
              <Button type="submit" variant="outline" disabled={!connector}>
                <Search aria-hidden="true" size={16} />
                Diagnosticar PRODUCT
              </Button>
            </form>

            {productProbeResult ? (
              <div className="grid gap-4 rounded-md border bg-[var(--background)] p-3">
                <dl className="grid gap-2 sm:grid-cols-2">
                  <Result
                    label="PRODUCT"
                    value={single(productProbeResult.productId) ?? "-"}
                  />
                  <Result
                    label="PRODUCT encontrado"
                    value={
                      single(productProbeResult.productFound) === "true"
                        ? "sim"
                        : "nao"
                    }
                  />
                  <Result
                    label="Product status"
                    value={single(productProbeResult.productStatus) || "-"}
                  />
                  <Result
                    label="Product name"
                    value={single(productProbeResult.productName) || "-"}
                  />
                  <Result
                    label="API permalink"
                    value={
                      single(productProbeResult.productPermalink) ||
                      "indisponível"
                    }
                  />
                  <Result
                    label="PDP resolvida"
                    value={
                      single(productProbeResult.resolvedProductUrl) ||
                      "indisponível"
                    }
                  />
                  <Result
                    label="PDP source"
                    value={
                      single(productProbeResult.productUrlSource) ||
                      "indisponível"
                    }
                  />
                  <Result
                    label="Pictures"
                    value={
                      single(productProbeResult.productPictureCount) ?? "0"
                    }
                  />
                  <Result
                    label="buy_box_winner"
                    value={
                      single(productProbeResult.buyBoxWinnerPresent) === "true"
                        ? `presente (${single(productProbeResult.buyBoxWinnerItemId) ?? "-"})`
                        : "ausente"
                    }
                  />
                  <Result
                    label="HTTP product items"
                    value={
                      single(productProbeResult.productItemsHttpStatus) ?? "-"
                    }
                  />
                  <Result
                    label="Product items encontrados"
                    value={
                      single(productProbeResult.productItemsResultsCount) ?? "0"
                    }
                  />
                  <Result
                    label="IDs interpretados"
                    value={
                      single(productProbeResult.productItemsParsedCount) ?? "0"
                    }
                  />
                  <Result
                    label="IDs únicos para hidratação"
                    value={
                      single(productProbeResult.productItemsUniqueIds) ?? "0"
                    }
                  />
                  <Result
                    label="Hidratacoes solicitadas"
                    value={
                      single(
                        productProbeResult.productItemsHydrationRequested,
                      ) ?? "0"
                    }
                  />
                  <Result
                    label="Itens hidratados"
                    value={
                      single(productProbeResult.productItemsHydrated) ?? "0"
                    }
                  />
                  <Result
                    label="Itens utilizaveis"
                    value={single(productProbeResult.productItemsUsable) ?? "0"}
                  />
                  <Result
                    label="Item selecionado"
                    value={single(productProbeResult.selectedItemId) || "-"}
                  />
                  <Result
                    label="Selected seller ID"
                    value={single(productProbeResult.selectedSellerId) || "-"}
                  />
                  <Result
                    label="Selected price"
                    value={single(productProbeResult.selectedPrice) || "-"}
                  />
                  <Result
                    label="Selected free shipping"
                    value={
                      single(productProbeResult.selectedFreeShipping) === ""
                        ? "desconhecido"
                        : single(productProbeResult.selectedFreeShipping) ===
                            "true"
                          ? "sim"
                          : "nao"
                    }
                  />
                  <Result
                    label="Item hydration available"
                    value={
                      single(productProbeResult.itemHydrationAvailable) ===
                      "true"
                        ? "sim"
                        : "nao"
                    }
                  />
                  <Result
                    label="Enrichment"
                    value={
                      single(productProbeResult.detailEnrichmentStatus) ||
                      "indisponível"
                    }
                  />
                  <Result
                    label="Resolution eligible"
                    value={
                      single(productProbeResult.resolutionEligible) === "true"
                        ? "sim"
                        : "nao"
                    }
                  />
                </dl>

                <form
                  action={testMercadoLivreProductPdpAffiliateLinkAction}
                  className="grid gap-2"
                >
                  <input
                    name="productId"
                    type="hidden"
                    value={single(productProbeResult.productId) ?? ""}
                  />
                  <Button
                    type="submit"
                    variant="outline"
                    disabled={
                      single(productProbeResult.pdpFallbackEligible) !== "true"
                    }
                  >
                    Testar link afiliado da PDP
                  </Button>
                  <p className="text-xs text-[var(--muted-foreground)]">
                    Usa o permalink seguro da API ou a rota canonica MLB
                    estritamente validada. Nao cria Product, Offer ou ImportJob.
                  </p>
                </form>

                <div className="grid gap-2">
                  <div className="font-medium">Motivos de descarte</div>
                  {productProbeReasons.length > 0 ? (
                    <ul className="grid gap-1">
                      {productProbeReasons.map(([reason, count]) => (
                        <li key={reason}>
                          {reason}: {count}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-[var(--muted-foreground)]">
                      Nenhum descarte registrado.
                    </p>
                  )}
                </div>

                <div className="grid gap-2">
                  <div className="font-medium">Amostras sanitizadas</div>
                  {productProbeDiagnosticSamples.length > 0 ? (
                    <div className="grid gap-2">
                      {productProbeDiagnosticSamples.map((sample) => (
                        <dl
                          key={`${sample.itemId}-${sample.rejectedReason ?? "accepted"}`}
                          className="grid gap-1 rounded-md border bg-[var(--surface)] p-3"
                        >
                          <Result label="ITEM" value={sample.itemId} />
                          <Result
                            label="Campos do summary"
                            value={
                              sample.summaryFieldsPresent?.join(", ") || "-"
                            }
                          />
                          <Result
                            label="HTTP hydration"
                            value={
                              sample.hydrationHttpStatus?.toString() ?? "-"
                            }
                          />
                          <Result
                            label="Status / condition / estoque"
                            value={`${sample.hydratedStatus ?? "unknown"} / ${sample.hydratedCondition ?? "unknown"} / ${sample.hydratedAvailableQuantity ?? "unknown"}`}
                          />
                          <Result
                            label="Channels"
                            value={sample.hydratedChannels?.join(", ") || "-"}
                          />
                          <Result
                            label="Permalink / preco"
                            value={`${sample.hasPermalink ? "sim" : "nao"} / ${sample.hasPrice ? "sim" : "nao"}`}
                          />
                          <Result
                            label="Resultado"
                            value={sample.rejectedReason ?? "utilizavel"}
                          />
                        </dl>
                      ))}
                    </div>
                  ) : (
                    <p className="text-[var(--muted-foreground)]">
                      Nenhuma amostra disponivel.
                    </p>
                  )}
                </div>
              </div>
            ) : null}

            {productPdpAffiliateResult ? (
              <dl className="grid gap-2 rounded-md border bg-[var(--background)] p-3">
                <Result
                  label="PRODUCT"
                  value={single(productPdpAffiliateResult.productId) ?? "-"}
                />
                <Result
                  label="PDP source"
                  value={
                    single(productPdpAffiliateResult.pdpProductUrlSource) ?? "-"
                  }
                />
                <Result
                  label="Endpoint mode"
                  value={
                    single(
                      productPdpAffiliateResult.pdpAffiliateEndpointMode,
                    ) ?? "-"
                  }
                />
                <Result
                  label="Host do resultado"
                  value={
                    single(productPdpAffiliateResult.pdpAffiliateHost) ?? "-"
                  }
                />
                <Result
                  label="Comeca com https://meli.la/"
                  value={
                    single(productPdpAffiliateResult.pdpAffiliateMeliLa) ===
                    "true"
                      ? "sim"
                      : "nao"
                  }
                />
              </dl>
            ) : null}
          </CardContent>
        </Card>

        <Card id="historico" className="scroll-mt-24">
          <CardHeader>
            <CardTitle>Última importação</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 text-sm">
            <div className="grid gap-1">
              <span className="text-[var(--muted-foreground)]">Conta</span>
              <span>{account?.status ?? "DISCONNECTED"}</span>
            </div>
            <form
              method="get"
              className="grid gap-2 rounded-md border p-3 sm:grid-cols-2"
            >
              <Field label="Sessão">
                <Input
                  name="sessionFilter"
                  defaultValue={sessionFilter ?? ""}
                  placeholder="ID do ImportJob"
                />
              </Field>
              <Field label="Categoria">
                <Input
                  name="categoryFilter"
                  defaultValue={categoryFilter ?? ""}
                  placeholder="ID oficial"
                />
              </Field>
              <Field label="Marketplace">
                <Select name="marketplaceFilter" defaultValue="MERCADO_LIVRE">
                  <option value="MERCADO_LIVRE">Mercado Livre</option>
                </Select>
              </Field>
              <Field label="Status">
                <Select name="statusFilter" defaultValue={statusFilter ?? ""}>
                  <option value="">Todos</option>
                  <option value="RUNNING">Em execução</option>
                  <option value="SUCCEEDED">Concluída</option>
                  <option value="SUCCEEDED_WITH_ERRORS">Parcial</option>
                  <option value="FAILED">Falhou</option>
                </Select>
              </Field>
              <Field label="Data inicial">
                <Input
                  name="dateFilter"
                  type="date"
                  defaultValue={dateFilter ?? ""}
                />
              </Field>
              <div className="flex items-end">
                <Button type="submit" variant="outline">
                  Filtrar sessão
                </Button>
              </div>
            </form>
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
                {multiCategorySummary ? (
                  <div className="grid gap-3 rounded-md border bg-[var(--background)] p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium">Sessão multicategoria</span>
                      <span className="text-xs text-[var(--muted-foreground)]">
                        {multiCategorySummary.crossCategoryDuplicates}{" "}
                        duplicados · {multiCategorySummary.quotaNotMet} cotas
                        não atendidas
                      </span>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {multiCategorySummary.categories.map((category) => (
                        <div
                          key={category.categoryId}
                          className="rounded border p-2 text-xs"
                        >
                          <div className="font-medium">
                            {category.categoryId}
                          </div>
                          <div>
                            {category.valid} válidas · {category.rejected}{" "}
                            rejeitadas · {category.selected} selecionadas
                          </div>
                          {!category.quotaMet ? (
                            <div className="text-[var(--destructive)]">
                              {category.reason ?? "CATEGORY_QUOTA_NOT_MET"}
                            </div>
                          ) : null}
                        </div>
                      ))}
                    </div>
                    <div className="text-xs text-[var(--muted-foreground)]">
                      Distribuição:{" "}
                      {multiCategorySummary.distribution
                        .map(
                          (entry) => `${entry.position}. ${entry.categoryId}`,
                        )
                        .join(" → ") || "nenhuma oferta selecionada"}
                    </div>
                  </div>
                ) : null}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
        <Card id="categorias" className="scroll-mt-24">
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
                  selectedCategory && selectedCategory.children.length === 0 ? (
                    <div className="grid gap-4 rounded-[var(--radius-lg)] border border-[var(--border-strong)] bg-[var(--primary-subtle)] p-5">
                      <div>
                        <StatusBadge status="ACTIVE" label="Categoria folha" />
                        <h3 className="mt-3 text-lg font-semibold">
                          {selectedCategory.name}
                        </h3>
                        <p className="mt-1 text-sm text-[var(--foreground-secondary)]">
                          Esta categoria pode ser usada na descoberta por
                          ranking quando houver destaques disponíveis.
                        </p>
                        <p className="mt-2 font-mono text-xs text-[var(--muted-foreground)]">
                          {selectedCategory.id}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {configuredCategoryIds.has(selectedCategory.id) ? (
                          <>
                            <StatusBadge
                              status="SUCCEEDED"
                              label="Categoria adicionada"
                            />
                            <Button asChild variant="outline">
                              <a href="#categorias-configuradas">
                                Configurar ou desativar
                              </a>
                            </Button>
                          </>
                        ) : (
                          <form action={addMercadoLivreCategoryAction}>
                            <input
                              name="categoryId"
                              type="hidden"
                              value={selectedCategory.id}
                            />
                            <Button type="submit">
                              <Plus aria-hidden="true" size={16} />
                              Adicionar categoria
                            </Button>
                          </form>
                        )}
                      </div>
                    </div>
                  ) : (
                    <EmptyState
                      title="Nenhuma subcategoria disponível"
                      description="Volte ao nível anterior para escolher outra categoria oficial do Mercado Livre."
                    />
                  )
                ) : (
                  <div className="grid gap-3">
                    {categoryRows.map(({ summary, details }) => {
                      const isLeaf = (details?.children.length ?? 1) === 0;

                      return (
                        <div
                          key={summary.id}
                          className="grid gap-3 rounded-md border bg-[var(--surface)] p-4 md:grid-cols-[1fr_auto]"
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
                              configuredCategoryIds.has(summary.id) ? (
                                <div className="flex flex-wrap items-center gap-2">
                                  <StatusBadge
                                    status="SUCCEEDED"
                                    label="Categoria adicionada"
                                  />
                                  <Button asChild variant="outline" size="sm">
                                    <a href="#categorias-configuradas">
                                      Configurar
                                    </a>
                                  </Button>
                                </div>
                              ) : (
                                <form action={addMercadoLivreCategoryAction}>
                                  <input
                                    name="categoryId"
                                    type="hidden"
                                    value={summary.id}
                                  />
                                  <Button type="submit">
                                    <Plus aria-hidden="true" size={16} />
                                    Adicionar categoria
                                  </Button>
                                </form>
                              )
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
              <div
                id="category-test-results"
                className="grid scroll-mt-24 gap-3"
              >
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
                <div className="flex flex-wrap gap-2">
                  {testedCategoryIsLeaf && testedCategoryId ? (
                    testedCategoryAlreadyConfigured ? (
                      <StatusBadge
                        status="SUCCEEDED"
                        label="Categoria adicionada"
                      />
                    ) : (
                      <form action={addMercadoLivreCategoryAction}>
                        <input
                          name="categoryId"
                          type="hidden"
                          value={testedCategoryId}
                        />
                        <Button type="submit">
                          <Plus aria-hidden="true" size={16} />
                          Adicionar categoria
                        </Button>
                      </form>
                    )
                  ) : null}
                  <Button asChild variant="outline">
                    <a href="#categorias">Voltar às categorias</a>
                  </Button>
                  <Button asChild variant="outline">
                    <a href="#diagnosticos">Ver candidatos</a>
                  </Button>
                </div>
              </div>
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
                      className="rounded-md border bg-[var(--surface)] p-3"
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
                  <div className="grid gap-3 rounded-md border bg-[var(--surface)] p-3">
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
