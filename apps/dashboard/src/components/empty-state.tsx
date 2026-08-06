import { Inbox } from "lucide-react";
import Link from "next/link";
import React from "react";
import { Button } from "@/components/ui/button";

type EmptyStateProps = {
  title: string;
  description: string;
  actionHref?: string;
  actionLabel?: string;
  icon?: typeof Inbox;
};

export function EmptyState({
  title,
  description,
  actionHref,
  actionLabel,
  icon: Icon = Inbox,
}: EmptyStateProps) {
  return (
    <div className="grid min-h-48 place-items-center rounded-[var(--radius-lg)] border border-dashed border-[var(--border-strong)] bg-[var(--surface)] px-6 py-10 text-center">
      <div className="max-w-xl">
        <span className="mx-auto grid size-11 place-items-center rounded-full bg-[var(--muted)] text-[var(--foreground-secondary)]">
          <Icon aria-hidden="true" size={20} />
        </span>
        <h2 className="mt-4 text-base font-semibold">{title}</h2>
        <p className="mt-2 text-sm text-[var(--foreground-secondary)]">
          {description}
        </p>
        {actionHref && actionLabel ? (
          <Button asChild className="mt-5">
            <Link href={actionHref}>{actionLabel}</Link>
          </Button>
        ) : null}
      </div>
    </div>
  );
}
