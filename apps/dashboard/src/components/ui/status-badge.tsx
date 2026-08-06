import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  CircleDashed,
  Clock3,
  HelpCircle,
  Info,
  LoaderCircle,
  PauseCircle,
  XCircle,
} from "lucide-react";
import React from "react";
import { cn } from "@/lib/utils";

export type StatusTone = "success" | "info" | "warning" | "danger" | "neutral";

const statusMap: Record<
  string,
  { label: string; tone: StatusTone; icon: typeof CheckCircle2 }
> = {
  ACTIVE: { label: "Ativo", tone: "success", icon: CheckCircle2 },
  ONLINE: { label: "Online", tone: "success", icon: CheckCircle2 },
  OK: { label: "Saudável", tone: "success", icon: CheckCircle2 },
  CONNECTED: { label: "Conectado", tone: "success", icon: CheckCircle2 },
  SUCCEEDED: { label: "Concluído", tone: "success", icon: CheckCircle2 },
  PUBLISHED: { label: "Publicado", tone: "success", icon: CheckCircle2 },
  READY_TO_PUBLISH: {
    label: "Pronta para publicar",
    tone: "success",
    icon: CheckCircle2,
  },
  RUNNING: { label: "Em andamento", tone: "info", icon: LoaderCircle },
  SCHEDULED: { label: "Agendada", tone: "info", icon: Clock3 },
  READY_FOR_AFFILIATE_LINK: {
    label: "Aguardando link",
    tone: "warning",
    icon: Clock3,
  },
  AWAITING_MANUAL_PUBLICATION: {
    label: "Aguardando publicação",
    tone: "warning",
    icon: Clock3,
  },
  PARTIAL: {
    label: "Concluído com ressalvas",
    tone: "warning",
    icon: AlertTriangle,
  },
  SUCCEEDED_WITH_ERRORS: {
    label: "Concluído com erros",
    tone: "warning",
    icon: AlertTriangle,
  },
  DEGRADED: { label: "Degradado", tone: "warning", icon: AlertTriangle },
  STALE: { label: "Heartbeat atrasado", tone: "warning", icon: AlertTriangle },
  DELIVERY_UNCERTAIN: {
    label: "Entrega incerta",
    tone: "danger",
    icon: AlertTriangle,
  },
  FAILED: { label: "Falhou", tone: "danger", icon: XCircle },
  PUBLICATION_FAILED: {
    label: "Falha na publicação",
    tone: "danger",
    icon: XCircle,
  },
  REJECTED: { label: "Rejeitada", tone: "danger", icon: Ban },
  BLOCKED: { label: "Bloqueado", tone: "danger", icon: Ban },
  DISABLED: { label: "Desabilitado", tone: "neutral", icon: PauseCircle },
  DISCONNECTED: { label: "Desconectado", tone: "neutral", icon: CircleDashed },
  OFFLINE: { label: "Offline", tone: "neutral", icon: CircleDashed },
  CANCELLED: { label: "Cancelada", tone: "neutral", icon: Ban },
  UNKNOWN: { label: "Desconhecido", tone: "neutral", icon: HelpCircle },
  INFO: { label: "Informativo", tone: "info", icon: Info },
  WARNING: { label: "Atenção", tone: "warning", icon: AlertTriangle },
  ERROR: { label: "Erro", tone: "danger", icon: XCircle },
  CRITICAL: { label: "Crítico", tone: "danger", icon: AlertTriangle },
};

const toneStyles: Record<StatusTone, string> = {
  success:
    "border-[color-mix(in_srgb,var(--success)_35%,var(--border))] bg-[var(--success-subtle)] text-[var(--success)]",
  info: "border-[color-mix(in_srgb,var(--info)_35%,var(--border))] bg-[var(--info-subtle)] text-[var(--info)]",
  warning:
    "border-[color-mix(in_srgb,var(--warning)_35%,var(--border))] bg-[var(--warning-subtle)] text-[var(--warning)]",
  danger:
    "border-[color-mix(in_srgb,var(--danger)_35%,var(--border))] bg-[var(--danger-subtle)] text-[var(--danger)]",
  neutral:
    "border-[var(--border)] bg-[var(--muted)] text-[var(--foreground-secondary)]",
};

export function StatusBadge({
  status,
  label,
  tone,
  className,
}: {
  status: string | null | undefined;
  label?: string;
  tone?: StatusTone;
  className?: string;
}) {
  const normalized = status?.toUpperCase() ?? "UNKNOWN";
  const definition = statusMap[normalized] ?? {
    label: status
      ? status.replaceAll("_", " ").toLocaleLowerCase("pt-BR")
      : "Desconhecido",
    tone: "neutral" as const,
    icon: HelpCircle,
  };
  const Icon = definition.icon;
  return (
    <span
      className={cn(
        "inline-flex min-h-7 w-fit items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold",
        toneStyles[tone ?? definition.tone],
        className,
      )}
    >
      <Icon
        aria-hidden="true"
        size={13}
        className={normalized === "RUNNING" ? "animate-spin" : undefined}
      />
      {label ?? definition.label}
    </span>
  );
}
