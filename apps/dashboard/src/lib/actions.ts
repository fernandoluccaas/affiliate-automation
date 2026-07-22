"use server";

import { prisma } from "@affiliate/database";
import bcrypt from "bcryptjs";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createSession, destroySession } from "./session";
import { ingestOffer } from "./offer-ingest";
import { offerFormSchema, type OfferFormValues } from "./offer-form-schema";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export type LoginState = {
  error?: string;
};

export async function loginAction(_state: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return { error: "Informe email e senha validos." };
  }

  const user = await prisma.user.findUnique({
    where: { email: parsed.data.email },
    select: { id: true, email: true, role: true, passwordHash: true },
  });

  if (!user) {
    return { error: "Credenciais invalidas." };
  }

  const passwordMatches = await bcrypt.compare(parsed.data.password, user.passwordHash);

  if (!passwordMatches) {
    return { error: "Credenciais invalidas." };
  }

  await createSession({ id: user.id, email: user.email, role: user.role });
  redirect("/");
}

export async function logoutAction() {
  await destroySession();
  redirect("/login");
}

export type CreateOfferState = {
  ok: boolean;
  message: string;
  offerId?: string | undefined;
};

export async function createManualOfferAction(input: OfferFormValues): Promise<CreateOfferState> {
  const parsed = offerFormSchema.safeParse(input);

  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? "Dados da oferta invalidos.",
    };
  }

  const result = await ingestOffer(parsed.data);

  return {
    ok: result.ok,
    offerId: result.offerId,
    message: result.ok
      ? `Oferta cadastrada com score ${result.score} e status READY_TO_PUBLISH.`
      : `Oferta processada com status ${result.status}: ${result.statusReason}`,
  };
}
