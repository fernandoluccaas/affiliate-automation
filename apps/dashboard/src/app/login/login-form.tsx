"use client";

import React, { useActionState } from "react";
import { LogIn } from "lucide-react";
import { loginAction, type LoginState } from "@/lib/actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert } from "@/components/ui/alert";

const initialState: LoginState = {};

export function LoginForm() {
  const [state, formAction, pending] = useActionState(
    loginAction,
    initialState,
  );

  return (
    <Card className="w-full shadow-[var(--shadow-md)]">
      <CardHeader className="text-center">
        <CardTitle className="text-xl">Acesso administrativo</CardTitle>
        <p className="text-sm text-[var(--foreground-secondary)]">
          Entre com sua conta para operar o dashboard.
        </p>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              autoFocus
              required
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="password">Senha</Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </div>
          {state.error ? (
            <Alert tone="danger" live>
              {state.error}
            </Alert>
          ) : null}
          <Button type="submit" loading={pending} loadingLabel="Entrando…">
            <LogIn aria-hidden="true" size={18} />
            Entrar
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
