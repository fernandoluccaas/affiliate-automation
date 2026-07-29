import { prisma } from "@affiliate/database";
import {
  MercadoLivreAffiliateApiError,
  MercadoLivreAffiliateLinkService,
  MercadoLivreAffiliateSessionService,
  decryptSecret,
  emitMercadoLivreOperationalMetric,
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
    | "LINK_GENERATED"
    | "NOT_CONFIGURED"
    | "ACCOUNT_NOT_FOUND"
    | "INVALID_INPUT"
    | "EXPIRED"
    | "ERROR";
  status: AffiliateSessionStatus;
  affiliateTag?: string | null;
  availableTags?: MercadoLivreAffiliateTag[];
  affiliateUrl?: string;
  provider?: "stripe_v2";
  generatedAt?: Date;
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
  monotonicNow: () => number;
  emitOperationalMetric: typeof emitMercadoLivreOperationalMetric;
};

export type SaveMercadoLivreAffiliateSessionInput = {
  sampleAffiliateLink?: string | null | undefined;
  cookie?: string | null | undefined;
  affiliateTag?: string | null | undefined;
};

export type GenerateMercadoLivreAffiliateTestLinkInput = {
  productUrl: string;
  affiliateTag?: string | null;
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
    monotonicNow: overrides.monotonicNow ?? Date.now,
    emitOperationalMetric:
      overrides.emitOperationalMetric ?? emitMercadoLivreOperationalMetric,
  };
}

function emitSessionValidation(
  deps: MercadoLivreAffiliateSessionDependencies,
  input: {
    marketplaceAccountId: string;
    startedAt: number;
    status: AffiliateSessionStatus;
    errorCode?: string;
  },
) {
  const durationMs = Math.max(0, deps.monotonicNow() - input.startedAt);
  try {
    deps.emitOperationalMetric("mercadolivre_affiliate_session_validation", {
      marketplaceAccountId: input.marketplaceAccountId,
      stage: "SESSION_VALIDATION",
      durationMs,
      status: input.status,
      ...(input.errorCode ? { errorCode: input.errorCode } : {}),
      count: 1,
    });

    if (input.status === "EXPIRED") {
      deps.emitOperationalMetric("mercadolivre_affiliate_session_expired", {
        marketplaceAccountId: input.marketplaceAccountId,
        stage: "SESSION_VALIDATION",
        durationMs,
        status: input.status,
        ...(input.errorCode ? { errorCode: input.errorCode } : {}),
        count: 1,
      });
    }
  } catch {
    // Observability must not change the result of the session operation.
  }
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
  const validationStartedAt = deps.monotonicNow();

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
    emitSessionValidation(deps, {
      marketplaceAccountId: account.id,
      startedAt: validationStartedAt,
      status: "CONNECTED",
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
    emitSessionValidation(deps, {
      marketplaceAccountId: account.id,
      startedAt: validationStartedAt,
      status: failure.status,
      errorCode: failure.code,
    });
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
  const validationStartedAt = deps.monotonicNow();

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
    emitSessionValidation(deps, {
      marketplaceAccountId: account.id,
      startedAt: validationStartedAt,
      status: "CONNECTED",
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
    emitSessionValidation(deps, {
      marketplaceAccountId: account.id,
      startedAt: validationStartedAt,
      status: failure.status,
      errorCode: failure.code,
    });
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

export async function generateMercadoLivreAffiliateTestLink(
  input: GenerateMercadoLivreAffiliateTestLinkInput,
  overrides: Partial<MercadoLivreAffiliateSessionDependencies> = {},
): Promise<MercadoLivreAffiliateSessionResult> {
  const deps = dependencies(overrides);
  const account = await findMercadoLivreAccount(deps.database);

  if (!account) {
    return noAccountResult();
  }

  const session = await deps.database.mercadoLivreAffiliateSession.findUnique({
    where: { marketplaceAccountId: account.id },
    select: {
      status: true,
      cookieEncrypted: true,
      csrfTokenEncrypted: true,
      affiliateTag: true,
      updatedAt: true,
    },
  });

  if (!session?.cookieEncrypted || session.status !== "CONNECTED") {
    return {
      ok: false,
      code: session?.status === "EXPIRED" ? "EXPIRED" : "NOT_CONFIGURED",
      status: session?.status === "EXPIRED" ? "EXPIRED" : "NOT_CONFIGURED",
    };
  }

  const affiliateTag =
    normalizedOptional(input.affiliateTag) ?? session.affiliateTag;

  if (!affiliateTag) {
    return invalidInputResult();
  }

  const now = deps.now();

  try {
    const productUrl = normalizeMercadoLivreAffiliateProductUrl(
      input.productUrl,
    );
    const cookie = normalizeMercadoLivreCookie(
      deps.decrypt(session.cookieEncrypted),
    );
    const csrfToken = session.csrfTokenEncrypted
      ? deps.decrypt(session.csrfTokenEncrypted)
      : null;
    const generated = await deps.createLinkService().create({
      productUrl,
      affiliateTag,
      cookie,
      csrfToken,
    });
    const refreshedCookie = generated.refreshedCookie ?? cookie;
    const refreshedCsrfToken =
      generated.refreshedCsrfToken === undefined
        ? csrfToken
        : generated.refreshedCsrfToken;

    await deps.database.mercadoLivreAffiliateSession.updateMany({
      where: {
        marketplaceAccountId: account.id,
        updatedAt: session.updatedAt,
      },
      data: {
        affiliateTag,
        cookieEncrypted: deps.encrypt(refreshedCookie),
        csrfTokenEncrypted: refreshedCsrfToken
          ? deps.encrypt(refreshedCsrfToken)
          : null,
        status: "CONNECTED",
        lastValidatedAt: now,
        ...(refreshedCookie !== cookie ? { lastCookieUpdateAt: now } : {}),
        lastErrorAt: null,
        lastError: null,
      },
    });

    return {
      ok: true,
      code: "LINK_GENERATED",
      status: "CONNECTED",
      affiliateTag,
      affiliateUrl: generated.affiliateUrl,
      provider: "stripe_v2",
      generatedAt: now,
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
