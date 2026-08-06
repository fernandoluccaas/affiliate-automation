import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Info,
  type LucideIcon,
} from "lucide-react";
import React from "react";
import { cn } from "@/lib/utils";

type AlertTone = "success" | "info" | "warning" | "danger";

const styles: Record<AlertTone, { className: string; icon: LucideIcon }> = {
  success: {
    className:
      "border-[color-mix(in_srgb,var(--success)_35%,var(--border))] bg-[var(--success-subtle)] text-[var(--success)]",
    icon: CheckCircle2,
  },
  info: {
    className:
      "border-[color-mix(in_srgb,var(--info)_35%,var(--border))] bg-[var(--info-subtle)] text-[var(--info)]",
    icon: Info,
  },
  warning: {
    className:
      "border-[color-mix(in_srgb,var(--warning)_35%,var(--border))] bg-[var(--warning-subtle)] text-[var(--warning)]",
    icon: AlertTriangle,
  },
  danger: {
    className:
      "border-[color-mix(in_srgb,var(--danger)_35%,var(--border))] bg-[var(--danger-subtle)] text-[var(--danger)]",
    icon: AlertCircle,
  },
};

export function Alert({
  tone = "info",
  title,
  children,
  className,
  live = false,
}: {
  tone?: AlertTone;
  title?: string;
  children: React.ReactNode;
  className?: string;
  live?: boolean;
}) {
  const style = styles[tone];
  const Icon = style.icon;
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      aria-live={live ? "polite" : undefined}
      className={cn(
        "flex gap-3 rounded-[var(--radius-md)] border p-4 text-sm",
        style.className,
        className,
      )}
    >
      <Icon aria-hidden="true" className="mt-0.5 shrink-0" size={18} />
      <div className="min-w-0 text-[var(--foreground)]">
        {title ? <p className="font-semibold">{title}</p> : null}
        <div
          className={cn(title && "mt-1", "text-[var(--foreground-secondary)]")}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
