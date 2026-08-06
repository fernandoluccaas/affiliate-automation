import { sanitizeMercadoLivreAffiliateErrorMessage } from "@affiliate/marketplace-connectors";

export function messageText(message?: string | string[]) {
  const value = Array.isArray(message) ? message[0] : message;
  if (value === "config-saved") return "Configuração salva.";
  if (value === "config-invalid") return "Revise os campos da configuração.";
  if (value === "category-added") return "Categoria folha adicionada.";
  if (value === "category-invalid") return "Informe um ID de categoria válido.";
  if (value === "category-not-found")
    return "Categoria não encontrada no Mercado Livre.";
  if (value === "category-api-error")
    return "Não foi possível consultar a categoria no Mercado Livre.";
  if (value === "category-not-leaf")
    return "Esta categoria possui subcategorias. Selecione uma categoria mais específica para usar o ranking de mais vendidos.";
  if (value === "category-tested") return "Teste de categoria concluído.";
  if (value === "sync-ok")
    return "Importação dos mais vendidos concluída. Consulte as métricas reais da última execução.";
  if (value === "sync-partial")
    return "Importação concluída parcialmente. Consulte as métricas e alertas.";
  if (value === "sync-already-running")
    return "Já existe uma sincronização Mercado Livre em andamento.";
  if (value === "sync-source-disabled")
    return "Descoberta por highlights está desabilitada.";
  if (value === "sync-failed")
    return "A importação falhou. Veja os alertas antes de tentar novamente.";
  if (value === "category-search-tested")
    return "Probe de busca da categoria concluído.";
  if (value === "product-diagnosed") return "Diagnóstico de PRODUCT concluído.";
  if (value === "product-diagnostic-invalid")
    return "Informe um PRODUCT ID válido no formato MLB seguido de números.";
  if (value === "product-diagnostic-error")
    return "Não foi possível diagnosticar o PRODUCT na API oficial.";
  if (value === "product-pdp-affiliate-tested")
    return "O Portal de Afiliados aceitou a PDP resolvida do catálogo.";
  if (value === "product-pdp-url-unavailable")
    return "Não foi possível resolver uma PDP oficial ou canônica segura; nenhum link foi solicitado.";
  if (value === "product-pdp-affiliate-unsupported")
    return "O Portal de Afiliados não aceitou o permalink oficial da PDP.";
  if (value === "product-pdp-affiliate-error")
    return "Não foi possível testar o link afiliado da PDP.";
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

export function affiliateSessionStatusLabel(status?: string | null) {
  if (status === "VALIDATING") return "Validando";
  if (status === "CONNECTED") return "Conectado";
  if (status === "EXPIRED") return "Cookie expirado";
  if (status === "ERROR") return "Erro";
  return "Não configurado";
}

export function jsonStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function lastRunMetrics(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>).filter(
    ([, item]) => typeof item === "number",
  );
}

export function lastRunObjectMetrics(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
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

export function multiCategoryRunSummary(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const multiCategory = (value as Record<string, unknown>).multiCategory;
  if (
    !multiCategory ||
    typeof multiCategory !== "object" ||
    Array.isArray(multiCategory)
  )
    return null;
  const record = multiCategory as Record<string, unknown>;
  const categories = Array.isArray(record.categories)
    ? record.categories.flatMap((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry))
          return [];
        const category = entry as Record<string, unknown>;
        return typeof category.categoryId === "string"
          ? [
              {
                categoryId: category.categoryId,
                requested: Number(category.requested ?? 0),
                valid: Number(category.valid ?? 0),
                rejected: Number(category.rejected ?? 0),
                selected: Number(category.selected ?? 0),
                quotaMet: category.quotaMet === true,
                reason:
                  typeof category.reason === "string" ? category.reason : null,
              },
            ]
          : [];
      })
    : [];
  const distribution = Array.isArray(record.distribution)
    ? record.distribution.flatMap((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry))
          return [];
        const item = entry as Record<string, unknown>;
        return typeof item.categoryId === "string"
          ? [
              {
                position: Number(item.position ?? 0),
                categoryId: item.categoryId,
              },
            ]
          : [];
      })
    : [];
  return {
    categories,
    distribution,
    crossCategoryDuplicates: Number(record.crossCategoryDuplicates ?? 0),
    quotaNotMet: Number(record.quotaNotMet ?? 0),
  };
}

export function importJobStatusLabel(status: string) {
  if (status === "QUEUED") return "Na fila";
  if (status === "RUNNING") return "Em execução";
  if (status === "SUCCEEDED") return "Concluída";
  if (status === "SUCCEEDED_WITH_ERRORS") return "Concluída com erros";
  if (status === "FAILED") return "Falhou";
  return status;
}

export function sanitizedImportError(value: string | null) {
  return value ? sanitizeMercadoLivreAffiliateErrorMessage(value) : "-";
}

export function single(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export function probeSample(value: string | string[] | undefined) {
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

export function probeCause(value: string | string[] | undefined) {
  const raw = single(value);
  if (!raw) return "-";
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return "-";
    const entries = parsed.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const cause = item as Record<string, unknown>;
      const parts = [
        cause.code,
        cause.message,
        cause.type,
        cause.department,
        cause.causeId,
      ].filter((part): part is string => typeof part === "string" && !!part);
      return parts.length ? [parts.join(": ")] : [];
    });
    return entries.length ? entries.join(" | ") : "-";
  } catch {
    return "-";
  }
}

export function productProbeRejectionReasons(
  value: string | string[] | undefined,
) {
  const raw = single(value);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return [];
    return Object.entries(parsed as Record<string, unknown>).filter(
      (entry): entry is [string, number] =>
        typeof entry[1] === "number" && entry[1] > 0,
    );
  } catch {
    return [];
  }
}

export type ProductProbeSample = {
  itemId: string;
  summaryFieldsPresent: string[];
  hydrationHttpStatus?: number;
  hydratedStatus?: string;
  hydratedCondition?: string;
  hydratedAvailableQuantity?: number;
  hydratedChannels?: string[];
  hasPermalink?: boolean;
  hasPrice?: boolean;
  rejectedReason?: string;
};

export function productProbeSamples(value: string | string[] | undefined) {
  const raw = single(value);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is ProductProbeSample =>
          item &&
          typeof item === "object" &&
          typeof (item as { itemId?: unknown }).itemId === "string",
      )
      .slice(0, 3);
  } catch {
    return [];
  }
}
