"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import {
  clearMercadoLivreAffiliateSession,
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
  });

  if (!parsed.success) {
    redirect("/integracoes/mercado-livre?message=affiliate-session-invalid");
  }

  // The bounded enrichment use case is added in Phase 3. Keeping this action
  // explicit avoids pretending that the current request generated links.
  revalidateMercadoLivreAffiliatePages();
  redirect("/integracoes/mercado-livre?message=affiliate-links-unavailable");
}
