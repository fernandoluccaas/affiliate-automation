import { cn } from "@/lib/utils";
import React from "react";

export function Section({
  className,
  ...props
}: React.HTMLAttributes<HTMLElement>) {
  return (
    <section
      className={cn(
        "rounded-[var(--radius-lg)] border bg-[var(--surface)] p-5 shadow-[var(--shadow-sm)] sm:p-6",
        className,
      )}
      {...props}
    />
  );
}

export function SectionHeader({
  title,
  description,
  actions,
  className,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between",
        className,
      )}
    >
      <div>
        <h2 className="text-base font-semibold sm:text-lg">{title}</h2>
        {description ? (
          <p className="mt-1 max-w-3xl text-sm text-[var(--foreground-secondary)]">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

export function MetricGrid({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("grid gap-3 sm:grid-cols-2 xl:grid-cols-4", className)}
      {...props}
    />
  );
}

export function MetricCard({
  label,
  value,
  detail,
  icon: Icon,
  tone = "default",
}: {
  label: string;
  value: React.ReactNode;
  detail?: React.ReactNode;
  icon?: React.ComponentType<{
    size?: number;
    "aria-hidden"?: boolean;
    className?: string;
  }>;
  tone?: "default" | "success" | "warning" | "danger";
}) {
  const toneClass =
    tone === "success"
      ? "text-[var(--success)]"
      : tone === "warning"
        ? "text-[var(--warning)]"
        : tone === "danger"
          ? "text-[var(--danger)]"
          : "text-[var(--primary)]";
  return (
    <article className="rounded-[var(--radius-lg)] border bg-[var(--surface)] p-4 shadow-[var(--shadow-sm)] sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium text-[var(--foreground-secondary)]">
          {label}
        </p>
        {Icon ? (
          <Icon aria-hidden={true} size={18} className={toneClass} />
        ) : null}
      </div>
      <p className="mt-2 text-2xl font-semibold tracking-[-0.03em] tabular-nums">
        {value}
      </p>
      {detail ? (
        <p className="mt-1 text-xs text-[var(--muted-foreground)]">{detail}</p>
      ) : null}
    </article>
  );
}

export function TechnicalDetails({
  summary = "Detalhes técnicos",
  children,
  className,
}: {
  summary?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <details
      className={cn(
        "rounded-[var(--radius-md)] border bg-[var(--muted)] px-4",
        className,
      )}
    >
      <summary className="cursor-pointer font-semibold">{summary}</summary>
      <div className="border-t py-4 text-sm">{children}</div>
    </details>
  );
}
