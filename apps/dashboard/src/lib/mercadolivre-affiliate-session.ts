import { prisma } from "@affiliate/database";
import {
  MercadoLivreAffiliateApiError,
  MercadoLivreAffiliateLinkService,
  MercadoLivreAffiliateSessionService,
  decryptSecret,
  encryptSecret,
  isMercadoLivreAffiliateApiError,
  normalizeMercadoLivreCookie,
  normalizeMercadoLivreAffiliateProductUrl,
  normalizeMercadoLivreGeneratedAffiliateUrl,
  parseMercadoLivreAffiliateTags,
  sanitizeMercadoLivreAffiliateError,
  type MercadoLivreAffiliateTag,
} from "@affiliate/marketplace-connectors";

type AffiliateSessionStatus =
  "NOT_CONFIGURED" | "VALIDATING" | "CONNECTED" | "EXPIRED" | "ERROR";

export type MercadoLivreAffiliateSessionResult = {
  ok: boolean;
  code:
    | "SAVED"
    | "TESTED"
    | "CLEARED"
    | "TAG_SELECTED"
    | "NOT_CONFIGURED"
    | "ACCOUNT_NOT_FOUND"
    | "INVALID_INPUT"
    | "EXPIRED"
    | "ERROR";
  status: AffiliateSessionStatus;
  affiliateTag?: string | null;
  availableTags?: MercadoLivreAffiliateTag[];
  errorMessage?: string;
};

type SessionService = Pick<
  MercadoLivreAffiliateSessionService,
  "validateSession"
>;
type LinkService = Pick<MercadoLivreAffiliateLinkService, "create">;

export type MercadoLivreAffiliateSessionDependencies = {
  database: typeof prisma;
  createSessionService: () => SessionService;
  createLinkService: () => LinkService;
  encrypt: typeof encryptSecret;
  decrypt: typeof decryptSecret;
  now: () => Date;
};

export type SaveMercadoLivreAffiliateSessionInput = {
  sampleAffiliateLink?: string | null | undefined;
  cookie?: string | null | undefined;
  affiliateTag?: string | null | undefined;
};

function dependencies(
  overrides: Partial<MercadoLivreAffiliateSessionDependencies> = {},
): MercadoLivreAffiliateSessionDependencies {
  return {
    database: overrides.database ?? prisma,
    createSessionService:
      overrides.createSessionService ??
      (() => new MercadoLivreAffiliateSessionService()),
    createLinkService:
      overrides.createLinkService ??
      (() => new MercadoLivreAffiliateLinkService()),
    encrypt: overrides.encrypt ?? encryptSecret,
    decrypt: overrides.decrypt ?? decryptSecret,
    now: overrides.now ?? (() => new Date()),
  };
}

function normalizedOptional(value?: string | null) {
  const normalized = value?.trim();
  return normalized || null;
}

function tagsForPersistence(tags: MercadoLivreAffiliateTag[]) {
  return tags.map((tag) => ({
    ...(tag.id ? { id: tag.id } : {}),
    value: tag.value,
    label: tag.label,
    isDefault: tag.isDefault,
  }));
}

function noAccountResult(): MercadoLivreAffiliateSessionResult {
  return {
    ok: false,
    code: "ACCOUNT_NOT_FOUND",
    status: "NOT_CONFIGURED",
  };
}

function invalidInputResult(): MercadoLivreAffiliateSessionResult {
  return {
    ok: false,
    code: "INVALID_INPUT",
    status: "ERROR",
  };
}

function classifiedFailure(error: unknown) {
  const expired =
    isMercadoLivreAffiliateApiError(error) && error.sessionExpired;
  return {
    status: (expired ? "EXPIRED" : "ERROR") as AffiliateSessionStatus,
    code: (expired ? "EXPIRED" : "ERROR") as "EXPIRED" | "ERROR",
    message: isMercadoLivreAffiliateApiError(error)
      ? sanitizeMercadoLivreAffiliateError(error)
      : "Mercado Livre affiliate operation failed.",
  };
}

async function findMercadoLivreAccount(database: typeof prisma) {
  return database.marketplaceAccount.findFirst({
    where: { marketplace: "MERCADO_LIVRE", enabled: true },
    orderBy: { updatedAt: "desc" },
    select: { id: true },
  });
}

async function persistFailure(
  database: typeof prisma,
  marketplaceAccountId: string,
  error: unknown,
  now: Date,
) {
  const failure = classifiedFailure(error);
  await database.mercadoLivreAffiliateSession.update({
    where: { marketplaceAccountId },
    data: {
      status: failure.status,
      lastErrorAt: now,
      lastError: failure.message,
    },
  });
  return failure;
}

function selectedTagOrThrow(selectedTag: MercadoLivreAffiliateTag | null) {
  if (selectedTag) {
    return selectedTag;
  }

  throw new MercadoLivreAffiliateApiError(
    "Mercado Livre affiliate account returned no selectable tags.",
    {
      stage: "TAGS",
      code: "NO_AFFILIATE_TAGS",
    },
  );
}

async function optionallyTestReferenceLink(input: {
  sampleAffiliateLink: string | null;
  affiliateTag: string;
  cookie: string;
  csrfToken: string | null;
  linkService: LinkService;
}) {
  if (!input.sampleAffiliateLink) {
    return {
      cookie: input.cookie,
      csrfToken: input.csrfToken,
    };
  }

  try {
    const productUrl = normalizeMercadoLivreAffiliateProductUrl(
      input.sampleAffiliateLink,
    );
    const generated = await input.linkService.create({
      productUrl,
      affiliateTag: input.affiliateTag,
      cookie: input.cookie,
      csrfToken: input.csrfToken,
    });
    return {
      cookie: generated.refreshedCookie ?? input.cookie,
      csrfToken:
        generated.refreshedCsrfToken === undefined
          ? input.csrfToken
          : generated.refreshedCsrfToken,
    };
  } catch (error) {
    if (
      isMercadoLivreAffiliateApiError(error) &&
      error.code === "INVALID_PRODUCT_URL"
    ) {
      normalizeMercadoLivreGeneratedAffiliateUrl(input.sampleAffiliateLink);
      return {
        cookie: input.cookie,
        csrfToken: input.csrfToken,
      };
    }

    throw error;
  }
}

function validateReferenceLink(value: string | null) {
  if (!value) {
    return true;
  }

  try {
    normalizeMercadoLivreAffiliateProductUrl(value);
    return true;
  } catch (error) {
    if (
      !isMercadoLivreAffiliateApiError(error) ||
      error.code !== "INVALID_PRODUCT_URL"
    ) {
      return false;
    }
  }

  try {
    normalizeMercadoLivreGeneratedAffiliateUrl(value);
    return true;
  } catch {
    return false;
  }
}

export async function saveMercadoLivreAffiliateSession(
  input: SaveMercadoLivreAffiliateSessionInput,
  overrides: Partial<MercadoLivreAffiliateSessionDependencies> = {},
): Promise<MercadoLivreAffiliateSessionResult> {
  const deps = dependencies(overrides);
  const account = await findMercadoLivreAccount(deps.database);

  if (!account) {
    return noAccountResult();
  }

  const existing = await deps.database.mercadoLivreAffiliateSession.findUnique({
    where: { marketplaceAccountId: account.id },
    select: {
      cookieEncrypted: true,
      csrfTokenEncrypted: true,
      affiliateTag: true,
      lastCookieUpdateAt: true,
    },
  });
  const suppliedCookie = normalizedOptional(input.cookie);
  const now = deps.now();
  let cookie = "";

  if (suppliedCookie) {
    try {
      cookie = normalizeMercadoLivreCookie(suppliedCookie);
    } catch {
      return invalidInputResult();
    }
  } else if (existing?.cookieEncrypted) {
    try {
      cookie = normalizeMercadoLivreCookie(
        deps.decrypt(existing.cookieEncrypted),
      );
    } catch {
      const failure = await persistFailure(
        deps.database,
        account.id,
        new Error("Stored affiliate credential is invalid."),
        now,
      );
      return {
        ok: false,
        code: failure.code,
        status: failure.status,
        errorMessage: failure.message,
      };
    }
  }

  if (!cookie) {
    return invalidInputResult();
  }

  const sampleAffiliateLink = normalizedOptional(input.sampleAffiliateLink);

  if (!validateReferenceLink(sampleAffiliateLink)) {
    return invalidInputResult();
  }

  const preferredTag =
    normalizedOptional(input.affiliateTag) ?? existing?.affiliateTag ?? null;
  let existingCsrfToken: string | null = null;

  if (!suppliedCookie && existing?.csrfTokenEncrypted) {
    try {
      existingCsrfToken = deps.decrypt(existing.csrfTokenEncrypted);
    } catch {
      const failure = await persistFailure(
        deps.database,
        account.id,
        new Error("Stored affiliate credential is invalid."),
        now,
      );
      return {
        ok: false,
        code: failure.code,
        status: failure.status,
        errorMessage: failure.message,
      };
    }
  }

  await deps.database.mercadoLivreAffiliateSession.upsert({
    where: { marketplaceAccountId: account.id },
    update: {
      sampleAffiliateLink,
      ...(suppliedCookie
        ? {
            cookieEncrypted: deps.encrypt(cookie),
            csrfTokenEncrypted: null,
            lastCookieUpdateAt: now,
          }
        : {}),
      affiliateTag: preferredTag,
      status: "VALIDATING",
      lastErrorAt: null,
      lastError: null,
    },
    create: {
      marketplaceAccountId: account.id,
      sampleAffiliateLink,
      cookieEncrypted: deps.encrypt(cookie),
      csrfTokenEncrypted: null,
      affiliateTag: preferredTag,
      status: "VALIDATING",
      lastCookieUpdateAt: now,
    },
  });

  try {
    const validation = await deps.createSessionService().validateSession({
      cookie,
      csrfToken: suppliedCookie ? null : existingCsrfToken,
      preferredTag,
    });
    const selectedTag = selectedTagOrThrow(validation.selectedTag);
    const tested = await optionallyTestReferenceLink({
      sampleAffiliateLink,
      affiliateTag: selectedTag.value,
      cookie: validation.cookie,
      csrfToken: validation.csrfToken,
      linkService: deps.createLinkService(),
    });
    const cookieChanged =
      suppliedCookie !== null ||
      tested.cookie !== cookie ||
      !existing?.lastCookieUpdateAt;

    await deps.database.mercadoLivreAffiliateSession.update({
      where: { marketplaceAccountId: account.id },
      data: {
        sampleAffiliateLink,
        affiliateTag: selectedTag.value,
        availableTags: tagsForPersistence(validation.tags),
        cookieEncrypted: deps.encrypt(tested.cookie),
        csrfTokenEncrypted: tested.csrfToken
          ? deps.encrypt(tested.csrfToken)
          : null,
        status: "CONNECTED",
        lastValidatedAt: now,
        ...(cookieChanged ? { lastCookieUpdateAt: now } : {}),
        lastErrorAt: null,
        lastError: null,
      },
    });

    return {
      ok: true,
      code: "SAVED",
      status: "CONNECTED",
      affiliateTag: selectedTag.value,
      availableTags: validation.tags,
    };
  } catch (error) {
    const failure = await persistFailure(deps.database, account.id, error, now);
    return {
      ok: false,
      code: failure.code,
      status: failure.status,
      errorMessage: failure.message,
    };
  }
}

export async function testMercadoLivreAffiliateSession(
  overrides: Partial<MercadoLivreAffiliateSessionDependencies> = {},
): Promise<MercadoLivreAffiliateSessionResult> {
  const deps = dependencies(overrides);
  const account = await findMercadoLivreAccount(deps.database);

  if (!account) {
    return noAccountResult();
  }

  const existing = await deps.database.mercadoLivreAffiliateSession.findUnique({
    where: { marketplaceAccountId: account.id },
    select: {
      cookieEncrypted: true,
      csrfTokenEncrypted: true,
      affiliateTag: true,
    },
  });

  if (!existing?.cookieEncrypted) {
    return {
      ok: false,
      code: "NOT_CONFIGURED",
      status: "NOT_CONFIGURED",
    };
  }

  const now = deps.now();
  await deps.database.mercadoLivreAffiliateSession.update({
    where: { marketplaceAccountId: account.id },
    data: {
      status: "VALIDATING",
      lastErrorAt: null,
      lastError: null,
    },
  });

  try {
    const cookie = normalizeMercadoLivreCookie(
      deps.decrypt(existing.cookieEncrypted),
    );
    const csrfToken = existing.csrfTokenEncrypted
      ? deps.decrypt(existing.csrfTokenEncrypted)
      : null;
    const validation = await deps.createSessionService().validateSession({
      cookie,
      csrfToken,
      preferredTag: existing.affiliateTag,
    });
    const selectedTag = selectedTagOrThrow(validation.selectedTag);
    const cookieChanged = validation.cookie !== cookie;

    await deps.database.mercadoLivreAffiliateSession.update({
      where: { marketplaceAccountId: account.id },
      data: {
        affiliateTag: selectedTag.value,
        availableTags: tagsForPersistence(validation.tags),
        cookieEncrypted: deps.encrypt(validation.cookie),
        csrfTokenEncrypted: validation.csrfToken
          ? deps.encrypt(validation.csrfToken)
          : null,
        status: "CONNECTED",
        lastValidatedAt: now,
        ...(cookieChanged ? { lastCookieUpdateAt: now } : {}),
        lastErrorAt: null,
        lastError: null,
      },
    });

    return {
      ok: true,
      code: "TESTED",
      status: "CONNECTED",
      affiliateTag: selectedTag.value,
      availableTags: validation.tags,
    };
  } catch (error) {
    const failure = await persistFailure(deps.database, account.id, error, now);
    return {
      ok: false,
      code: failure.code,
      status: failure.status,
      errorMessage: failure.message,
    };
  }
}

export async function clearMercadoLivreAffiliateSession(
  overrides: Partial<MercadoLivreAffiliateSessionDependencies> = {},
): Promise<MercadoLivreAffiliateSessionResult> {
  const deps = dependencies(overrides);
  const account = await findMercadoLivreAccount(deps.database);

  if (!account) {
    return noAccountResult();
  }

  await deps.database.mercadoLivreAffiliateSession.deleteMany({
    where: { marketplaceAccountId: account.id },
  });
  return {
    ok: true,
    code: "CLEARED",
    status: "NOT_CONFIGURED",
  };
}

export async function selectMercadoLivreAffiliateTag(
  affiliateTag: string,
  overrides: Partial<MercadoLivreAffiliateSessionDependencies> = {},
): Promise<MercadoLivreAffiliateSessionResult> {
  const deps = dependencies(overrides);
  const account = await findMercadoLivreAccount(deps.database);

  if (!account) {
    return noAccountResult();
  }

  const existing = await deps.database.mercadoLivreAffiliateSession.findUnique({
    where: { marketplaceAccountId: account.id },
    select: { availableTags: true, status: true },
  });
  const normalizedTag = affiliateTag.trim();
  const tags = parseMercadoLivreAffiliateTags(existing?.availableTags);
  const selected = tags.find(
    (tag) => tag.value === normalizedTag || tag.id === normalizedTag,
  );

  if (!existing || !selected) {
    return invalidInputResult();
  }

  await deps.database.mercadoLivreAffiliateSession.update({
    where: { marketplaceAccountId: account.id },
    data: { affiliateTag: selected.value },
  });
  return {
    ok: true,
    code: "TAG_SELECTED",
    status: existing.status,
    affiliateTag: selected.value,
    availableTags: tags,
  };
}
