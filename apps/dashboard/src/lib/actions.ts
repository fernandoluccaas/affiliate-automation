"use server";

import { prisma } from "@affiliate/database";
import bcrypt from "bcryptjs";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createSession, destroySession } from "./session";

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
