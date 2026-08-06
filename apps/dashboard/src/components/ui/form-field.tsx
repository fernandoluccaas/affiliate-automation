import React, { useId } from "react";
import { cn } from "@/lib/utils";

export function FormField({
  label,
  description,
  error,
  required,
  children,
  className,
  htmlFor,
}: {
  label: string;
  description?: string;
  error?: string;
  required?: boolean;
  children: React.ReactNode;
  className?: string;
  htmlFor?: string;
}) {
  const descriptionId = useId();
  const errorId = useId();
  return (
    <div className={cn("grid gap-2", className)}>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={htmlFor} className="text-sm font-semibold">
          {label}
        </label>
        <span className="text-xs text-[var(--muted-foreground)]">
          {required ? "Obrigatório" : "Opcional"}
        </span>
      </div>
      <div
        aria-describedby={
          [description ? descriptionId : null, error ? errorId : null]
            .filter(Boolean)
            .join(" ") || undefined
        }
      >
        {children}
      </div>
      {description ? (
        <p
          id={descriptionId}
          className="text-xs text-[var(--muted-foreground)]"
        >
          {description}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="text-sm text-[var(--danger)]">
          {error}
        </p>
      ) : null}
    </div>
  );
}
