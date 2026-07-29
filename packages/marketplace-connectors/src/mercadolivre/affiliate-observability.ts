import { sanitizeMercadoLivreAffiliateErrorMessage } from "./affiliate-errors";

export type MercadoLivreOperationalEvent =
  | "mercadolivre_affiliate_session_validation"
  | "mercadolivre_affiliate_link_generated"
  | "mercadolivre_affiliate_link_failed"
  | "mercadolivre_affiliate_session_expired"
  | "mercadolivre_discovery_items_found"
  | "mercadolivre_discovery_items_resolved"
  | "mercadolivre_discovery_items_ineligible"
  | "mercadolivre_discovery_items_pending_link"
  | "mercadolivre_import_created"
  | "mercadolivre_import_updated";

export type MercadoLivreOperationalMetricFields = {
  jobId?: string;
  marketplaceAccountId?: string;
  externalItemId?: string;
  stage?: string;
  durationMs?: number;
  status?: string;
  attempt?: number;
  count?: number;
  errorCode?: string | number;
};

export type MercadoLivreOperationalMetricWriter = (line: string) => void;

function safeText(value: string | number | undefined, maxLength: number) {
  if (value === undefined) {
    return undefined;
  }

  const normalized = String(value).trim();

  if (!normalized) {
    return undefined;
  }

  return sanitizeMercadoLivreAffiliateErrorMessage(normalized)
    .slice(0, maxLength)
    .trim();
}

function safeNonNegativeInteger(value: number | undefined) {
  return value !== undefined && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : undefined;
}

export function emitMercadoLivreOperationalMetric(
  event: MercadoLivreOperationalEvent,
  fields: MercadoLivreOperationalMetricFields,
  write: MercadoLivreOperationalMetricWriter = console.info,
) {
  const jobId = safeText(fields.jobId, 200);
  const marketplaceAccountId = safeText(fields.marketplaceAccountId, 200);
  const externalItemId = safeText(fields.externalItemId, 200);
  const stage = safeText(fields.stage, 100);
  const status = safeText(fields.status, 100);
  const errorCode = safeText(fields.errorCode, 100);
  const durationMs = safeNonNegativeInteger(fields.durationMs);
  const attempt = safeNonNegativeInteger(fields.attempt);
  const count = safeNonNegativeInteger(fields.count);

  write(
    JSON.stringify({
      event,
      ...(jobId ? { jobId } : {}),
      ...(marketplaceAccountId ? { marketplaceAccountId } : {}),
      ...(externalItemId ? { externalItemId } : {}),
      ...(stage ? { stage } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(status ? { status } : {}),
      ...(attempt !== undefined ? { attempt } : {}),
      ...(count !== undefined ? { count } : {}),
      ...(errorCode ? { errorCode } : {}),
    }),
  );
}
