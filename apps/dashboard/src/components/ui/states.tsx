import { AlertTriangle, LoaderCircle } from "lucide-react";
import React from "react";
import { Button } from "@/components/ui/button";

export function LoadingState({
  label = "Carregando dados…",
}: {
  label?: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-40 items-center justify-center gap-3 rounded-[var(--radius-lg)] border bg-[var(--surface)] text-sm text-[var(--foreground-secondary)]"
    >
      <LoaderCircle aria-hidden="true" className="animate-spin" size={20} />
      {label}
    </div>
  );
}

export function ErrorState({
  title = "Não foi possível carregar os dados.",
  description,
  onRetry,
}: {
  title?: string;
  description?: string;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="grid min-h-40 place-items-center rounded-[var(--radius-lg)] border border-[color-mix(in_srgb,var(--danger)_35%,var(--border))] bg-[var(--danger-subtle)] p-6 text-center"
    >
      <div>
        <AlertTriangle
          aria-hidden="true"
          className="mx-auto text-[var(--danger)]"
          size={22}
        />
        <h2 className="mt-3 font-semibold">{title}</h2>
        {description ? (
          <p className="mt-1 text-sm text-[var(--foreground-secondary)]">
            {description}
          </p>
        ) : null}
        {onRetry ? (
          <Button
            className="mt-4"
            variant="outline"
            type="button"
            onClick={onRetry}
          >
            Tentar novamente
          </Button>
        ) : null}
      </div>
    </div>
  );
}
