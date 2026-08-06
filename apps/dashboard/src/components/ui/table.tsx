import { cn } from "@/lib/utils";
import React from "react";

export function DataTableContainer({
  children,
  label = "Tabela com rolagem horizontal",
  className,
}: {
  children: React.ReactNode;
  label?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-[var(--radius-lg)] border bg-[var(--surface)] shadow-[var(--shadow-sm)]",
        className,
      )}
    >
      <div
        className="max-w-full overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
        tabIndex={0}
        role="region"
        aria-label={label}
      >
        {children}
      </div>
    </div>
  );
}

export function FilterBar({
  children,
  className,
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "grid gap-3 rounded-[var(--radius-lg)] border bg-[var(--surface)] p-4 shadow-[var(--shadow-sm)]",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function Pagination({
  summary,
  children,
}: {
  summary: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <nav
      aria-label="Paginação"
      className="flex flex-col gap-3 text-sm text-[var(--foreground-secondary)] sm:flex-row sm:items-center sm:justify-between"
    >
      <span aria-live="polite">{summary}</span>
      <div className="flex gap-2">{children}</div>
    </nav>
  );
}
