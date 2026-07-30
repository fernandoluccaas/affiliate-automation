"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import {
  createMercadoLivreConnector,
  resolveMercadoLivreCatalogProductUrl,
} from "@affiliate/marketplace-connectors";
import {
  generatePendingMercadoLivreAffiliateLinks,
  type GeneratePendingMercadoLivreAffiliateLinksResult,
} from "@affiliate/marketplace-discovery";
import {
  clearMercadoLivreAffiliateSession,
  generateMercadoLivreAffiliateTestLink,
  saveMercadoLivreAffiliateSession,
  selectMercadoLivreAffiliateTag,
  testMercadoLivreAffiliateSession,
  type MercadoLivreAffiliateSessionResult,
} from "./mercadolivre-affiliate-session";
import { requireSession } from "./session";

const affiliateSessionSchema = z.object({
  sampleAffiliateLink: z.preprocess(
    (value) => (value === "" || value === null ? undefined : value),
    z.string().trim().url().max(2_048).optional(),
  ),
  cookie: z.preprocess(
    (value) => (value === "" || value === null ? undefined : value),
    z.string().trim().min(1).max(65_535).optional(),
  ),
  affiliateTag: z.preprocess(
    (value) => (value === "" || value === null ? undefined : value),
    z.string().trim().min(1).max(200).optional(),
  ),
});

const affiliateTagSchema = z.object({
  affiliateTag: z.string().trim().min(1).max(200),
});

const pendingLinksSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(50),
  offerIds: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
  dryRun: z.boolean().default(false),
});

const testLinkSchema = z.object({
  productUrl: z.string().trim().url().max(2_048),
  affiliateTag: z.preprocess(
    (value) => (value === "" || value === null ? undefined : value),
    z.string().trim().min(1).max(200).optional(),
  ),
});

const productPdpSchema = z.object({
  productId: z
    .string()
    .trim()
    .regex(/^MLB\d+$/i),
});

async function requireAffiliateSessionManager() {
  const user = await requireSession();

  if (user.role === "VIEWER") {
    redirect("/integracoes/mercado-livre?message=affiliate-not-authorized");
  }

  return user;
}

function revalidateMercadoLivreAffiliatePages() {
  revalidatePath("/integracoes");
  revalidatePath("/integracoes/mercado-livre");
  revalidatePath("/ofertas");
  revalidatePath("/ofertas/affiliate-links");
}

function failureMessage(result: MercadoLivreAffiliateSessionResult) {
  if (result.code === "EXPIRED" || result.status === "EXPIRED") {
    return "affiliate-session-expired";
  }

  if (
    result.code === "INVALID_INPUT" ||
    result.code === "NOT_CONFIGURED" ||
    result.code === "ACCOUNT_NOT_FOUND"
  ) {
    return "affiliate-session-invalid";
  }

  return "affiliate-session-error";
}

function finish(
  result: MercadoLivreAffiliateSessionResult,
  successMessage: string,
) {
  revalidateMercadoLivreAffiliatePages();
  redirect(
    `/integracoes/mercado-livre?message=${
      result.ok ? successMessage : failureMessage(result)
    }`,
  );
}

async function safelyRunAffiliateOperation(
  operation: () => Promise<MercadoLivreAffiliateSessionResult>,
) {
  try {
    return await operation();
  } catch {
    return {
      ok: false,
      code: "ERROR",
      status: "ERROR",
    } satisfies MercadoLivreAffiliateSessionResult;
  }
}

export async function saveMercadoLivreAffiliateSessionAction(
  formData: FormData,
) {
  await requireAffiliateSessionManager();
  const parsed = affiliateSessionSchema.safeParse({
    sampleAffiliateLink: formData.get("sampleAffiliateLink"),
    cookie: formData.get("cookie"),
    affiliateTag: formData.get("affiliateTag"),
  });

  if (!parsed.success) {
    redirect("/integracoes/mercado-livre?message=affiliate-session-invalid");
  }

  const result = await safelyRunAffiliateOperation(() =>
    saveMercadoLivreAffiliateSession(parsed.data),
  );
  finish(result, "affiliate-session-saved");
}

export async function testMercadoLivreAffiliateSessionAction() {
  await requireAffiliateSessionManager();
  const result = await safelyRunAffiliateOperation(() =>
    testMercadoLivreAffiliateSession(),
  );
  finish(result, "affiliate-session-tested");
}

export async function generateMercadoLivreAffiliateTestLinkAction(
  formData: FormData,
) {
  await requireAffiliateSessionManager();
  const parsed = testLinkSchema.safeParse({
    productUrl: formData.get("productUrl"),
    affiliateTag: formData.get("affiliateTag"),
  });

  if (!parsed.success) {
    redirect("/integracoes/mercado-livre?message=affiliate-session-invalid");
  }

  const result = await safelyRunAffiliateOperation(() =>
    generateMercadoLivreAffiliateTestLink({
      productUrl: parsed.data.productUrl,
      ...(parsed.data.affiliateTag
        ? { affiliateTag: parsed.data.affiliateTag }
        : {}),
    }),
  );
  revalidateMercadoLivreAffiliatePages();

  if (!result.ok || !result.affiliateUrl) {
    redirect(`/integracoes/mercado-livre?message=${failureMessage(result)}`);
  }

  const query = new URLSearchParams({
    message: "affiliate-test-link-generated",
    generatedAffiliateUrl: result.affiliateUrl,
    affiliateEndpointMode: result.provider ?? "stripe_v2",
    generatedAt: result.generatedAt?.toISOString() ?? new Date().toISOString(),
  });
  redirect(`/integracoes/mercado-livre?${query.toString()}`);
}

export async function testMercadoLivreProductPdpAffiliateLinkAction(
  formData: FormData,
) {
  await requireAffiliateSessionManager();
  const parsed = productPdpSchema.safeParse({
    productId: formData.get("productId"),
  });

  if (!parsed.success) {
    redirect("/integracoes/mercado-livre?message=product-diagnostic-invalid");
  }

  const productId = parsed.data.productId.toUpperCase();
  let productUrl: string | null = null;
  let productUrlSource: "API_PERMALINK" | "CANONICAL_CATALOG_PDP" | null = null;

  try {
    const connector = await createMercadoLivreConnector();
    const product = await connector.getProduct(productId);

    if (product) {
      const resolved = resolveMercadoLivreCatalogProductUrl({
        productId: product.id,
        productPermalink: product.permalink,
        productStatus: product.status,
      });
      productUrl = resolved?.productUrl ?? null;
      productUrlSource = resolved?.source ?? null;
    }
  } catch {
    redirect(
      `/integracoes/mercado-livre?message=product-pdp-affiliate-error&productId=${encodeURIComponent(productId)}`,
    );
  }

  if (!productUrl) {
    redirect(
      `/integracoes/mercado-livre?message=product-pdp-url-unavailable&productId=${encodeURIComponent(productId)}`,
    );
  }

  const result = await safelyRunAffiliateOperation(() =>
    generateMercadoLivreAffiliateTestLink({ productUrl }),
  );

  if (!result.ok || !result.affiliateUrl) {
    redirect(
      `/integracoes/mercado-livre?message=product-pdp-affiliate-unsupported&productId=${encodeURIComponent(productId)}`,
    );
  }

  let affiliateHost = "";
  let startsWithMeliLa = false;

  try {
    affiliateHost = new URL(result.affiliateUrl).hostname;
    startsWithMeliLa = result.affiliateUrl.startsWith("https://meli.la/");
  } catch {
    redirect(
      `/integracoes/mercado-livre?message=product-pdp-affiliate-unsupported&productId=${encodeURIComponent(productId)}`,
    );
  }

  const query = new URLSearchParams({
    message: "product-pdp-affiliate-tested",
    productId,
    pdpAffiliateEndpointMode: result.provider ?? "stripe_v2",
    pdpAffiliateHost: affiliateHost,
    pdpAffiliateMeliLa: String(startsWithMeliLa),
    pdpProductUrlSource: productUrlSource ?? "",
  });
  redirect(`/integracoes/mercado-livre?${query.toString()}`);
}

export async function clearMercadoLivreAffiliateSessionAction() {
  await requireAffiliateSessionManager();
  const result = await safelyRunAffiliateOperation(() =>
    clearMercadoLivreAffiliateSession(),
  );
  finish(result, "affiliate-session-cleared");
}

export async function selectMercadoLivreAffiliateTagAction(formData: FormData) {
  await requireAffiliateSessionManager();
  const parsed = affiliateTagSchema.safeParse({
    affiliateTag: formData.get("affiliateTag"),
  });

  if (!parsed.success) {
    redirect("/integracoes/mercado-livre?message=affiliate-session-invalid");
  }

  const result = await safelyRunAffiliateOperation(() =>
    selectMercadoLivreAffiliateTag(parsed.data.affiliateTag),
  );
  finish(result, "affiliate-tag-selected");
}

export async function generatePendingMercadoLivreAffiliateLinksAction(
  formData: FormData,
) {
  await requireAffiliateSessionManager();
  const parsed = pendingLinksSchema.safeParse({
    limit: formData.get("limit") ?? 50,
    offerIds: formData
      .getAll("offerId")
      .filter((value): value is string => typeof value === "string"),
    dryRun:
      formData.get("dryRun") === "true" || formData.get("dryRun") === "on",
  });

  if (!parsed.success) {
    redirect("/integracoes/mercado-livre?message=affiliate-session-invalid");
  }

  let result: GeneratePendingMercadoLivreAffiliateLinksResult;

  try {
    result = await generatePendingMercadoLivreAffiliateLinks(parsed.data);
  } catch {
    revalidateMercadoLivreAffiliatePages();
    redirect("/integracoes/mercado-livre?message=affiliate-session-error");
  }

  revalidateMercadoLivreAffiliatePages();

  if (!result.ok) {
    redirect("/integracoes/mercado-livre?message=affiliate-session-error");
  }

  if (result.selected === 0) {
    redirect("/integracoes/mercado-livre?message=affiliate-links-none");
  }

  if (
    result.status === "PARTIAL" ||
    result.ineligible > 0 ||
    result.pending > 0 ||
    result.failed > 0
  ) {
    redirect("/integracoes/mercado-livre?message=affiliate-links-partial");
  }

  redirect("/integracoes/mercado-livre?message=affiliate-links-generated");
}
