export interface MercadoLivreAffiliateTag {
  id?: string;
  value: string;
  label: string;
  isDefault: boolean;
}

export interface CreateMercadoLivreAffiliateLinkInput {
  productUrl: string;
  affiliateTag: string;
  cookie: string;
  csrfToken?: string | null;
}

export interface CreateMercadoLivreAffiliateLinkResult {
  affiliateUrl: string;
  refreshedCookie?: string;
  refreshedCsrfToken?: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown) {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized || null;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return null;
}

function booleanFlag(value: unknown) {
  return (
    value === true ||
    value === 1 ||
    (typeof value === "string" &&
      ["true", "1", "yes"].includes(value.trim().toLowerCase()))
  );
}

function tagEntries(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }

  const response = asRecord(value);

  if (!response) {
    return [];
  }

  if (Array.isArray(response.tags)) {
    return response.tags;
  }

  if (response.tags !== undefined && response.tags !== null) {
    return [response.tags];
  }

  if (Array.isArray(response.data)) {
    return response.data;
  }

  const data = asRecord(response.data);

  if (!data) {
    return [];
  }

  if (Array.isArray(data.tags)) {
    return data.tags;
  }

  return data.tags === undefined || data.tags === null ? [] : [data.tags];
}

function normalizeTag(value: unknown): MercadoLivreAffiliateTag | null {
  const stringValue = nonEmptyString(value);

  if (stringValue) {
    return {
      value: stringValue,
      label: stringValue,
      isDefault: false,
    };
  }

  const record = asRecord(value);

  if (!record) {
    return null;
  }

  const id = nonEmptyString(record.id);
  const tagValue =
    nonEmptyString(record.tag) ??
    nonEmptyString(record.value) ??
    nonEmptyString(record.name) ??
    nonEmptyString(record.label) ??
    id;

  if (!tagValue) {
    return null;
  }

  const label =
    nonEmptyString(record.label) ??
    nonEmptyString(record.name) ??
    nonEmptyString(record.tag) ??
    tagValue;

  return {
    ...(id ? { id } : {}),
    value: tagValue,
    label,
    isDefault:
      booleanFlag(record.default) ||
      booleanFlag(record.is_default) ||
      booleanFlag(record.isDefault),
  };
}

export function parseMercadoLivreAffiliateTags(
  response: unknown,
): MercadoLivreAffiliateTag[] {
  const tags = new Map<string, MercadoLivreAffiliateTag>();

  for (const entry of tagEntries(response)) {
    const tag = normalizeTag(entry);

    if (!tag) {
      continue;
    }

    const existing = tags.get(tag.value);

    if (!existing) {
      tags.set(tag.value, tag);
      continue;
    }

    tags.set(tag.value, {
      ...(existing.id ? { id: existing.id } : tag.id ? { id: tag.id } : {}),
      value: existing.value,
      label:
        existing.label === existing.value && tag.label !== tag.value
          ? tag.label
          : existing.label,
      isDefault: existing.isDefault || tag.isDefault,
    });
  }

  return [...tags.values()];
}

export function selectMercadoLivreAffiliateTag(
  tags: readonly MercadoLivreAffiliateTag[],
  preferredValue?: string | null,
): MercadoLivreAffiliateTag | null {
  const normalizedPreferredValue = preferredValue?.trim();

  if (normalizedPreferredValue) {
    const preferred = tags.find(
      (tag) =>
        tag.value === normalizedPreferredValue ||
        tag.id === normalizedPreferredValue,
    );

    if (preferred) {
      return preferred;
    }
  }

  if (tags.length === 1) {
    return tags[0] ?? null;
  }

  return tags.find((tag) => tag.isDefault) ?? tags[0] ?? null;
}
