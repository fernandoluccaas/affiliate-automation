import { Check, Circle } from "lucide-react";
import React from "react";
import { cn } from "@/lib/utils";

const steps = [
  "Planejada",
  "Inspeção",
  "Autorização",
  "Preflight",
  "Envio",
  "Confirmação",
];

export function WhatsAppPublicationStepper({
  currentStep,
}: {
  currentStep: number;
}) {
  return (
    <ol
      aria-label="Etapas da publicação WhatsApp"
      className="grid gap-2 sm:grid-cols-3 xl:grid-cols-6"
    >
      {steps.map((step, index) => {
        const complete = index < currentStep;
        const current = index === currentStep;
        return (
          <li
            key={step}
            aria-current={current ? "step" : undefined}
            className={cn(
              "flex min-h-10 items-center gap-2 rounded-md border bg-[var(--surface)] px-2 py-1.5 text-xs",
              complete &&
                "border-[color-mix(in_srgb,var(--success)_35%,var(--border))] bg-[var(--success-subtle)]",
              current &&
                "border-[var(--primary)] bg-[var(--primary-subtle)] font-semibold",
            )}
          >
            <span
              className={cn(
                "grid size-5 shrink-0 place-items-center rounded-full border",
                complete &&
                  "border-[var(--success)] bg-[var(--success)] text-white",
                current && "border-[var(--primary)] text-[var(--primary)]",
              )}
            >
              {complete ? (
                <Check aria-hidden="true" size={12} />
              ) : (
                <Circle aria-hidden="true" size={9} />
              )}
            </span>
            {step}
          </li>
        );
      })}
    </ol>
  );
}
