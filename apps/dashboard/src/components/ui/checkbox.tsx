import * as React from "react";
import { cn } from "@/lib/utils";

export function Checkbox({
  label,
  description,
  className,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  description?: string;
}) {
  return (
    <label
      className={cn(
        "flex min-h-11 items-start gap-3 rounded-md py-2 text-sm",
        className,
      )}
    >
      <input
        {...props}
        type="checkbox"
        className="mt-0.5 size-5 accent-[var(--primary)]"
      />
      <span>
        <span className="font-medium">{label}</span>
        {description ? (
          <span className="block text-xs text-[var(--muted-foreground)]">
            {description}
          </span>
        ) : null}
      </span>
    </label>
  );
}

export function Switch({
  label,
  description,
  className,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  description?: string;
}) {
  return (
    <label
      className={cn(
        "flex min-h-11 items-center justify-between gap-4 rounded-md py-2 text-sm",
        className,
      )}
    >
      <span>
        <span className="font-medium">{label}</span>
        {description ? (
          <span className="block text-xs text-[var(--muted-foreground)]">
            {description}
          </span>
        ) : null}
      </span>
      <span className="relative inline-flex h-6 w-11 shrink-0">
        <input
          {...props}
          type="checkbox"
          role="switch"
          className="peer sr-only"
        />
        <span className="absolute inset-0 rounded-full bg-[var(--border-strong)] transition-colors peer-checked:bg-[var(--primary)] peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--focus-ring)]" />
        <span className="pointer-events-none absolute left-0.5 top-0.5 size-5 rounded-full bg-[var(--surface)] shadow transition-transform peer-checked:translate-x-5" />
      </span>
    </label>
  );
}
