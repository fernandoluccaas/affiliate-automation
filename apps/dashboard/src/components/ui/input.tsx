import * as React from "react";
import { cn } from "@/lib/utils";

export function Input({
  className,
  type,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      type={type}
      className={cn(
        "min-h-11 w-full rounded-[var(--radius-md)] border bg-[var(--surface)] px-3 py-2 text-sm text-[var(--foreground)] outline-none placeholder:text-[var(--muted-foreground)] focus-visible:border-[var(--focus-ring)] focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--focus-ring)_28%,transparent)] disabled:cursor-not-allowed disabled:bg-[var(--muted)] disabled:opacity-70",
        className,
      )}
      {...props}
    />
  );
}
