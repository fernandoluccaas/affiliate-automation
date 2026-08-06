import Link from "next/link";
import React from "react";
import { cn } from "@/lib/utils";

export type TabItem = { label: string; href: string; active?: boolean };

export function PageTabs({
  items,
  label = "Seções da página",
  className,
}: {
  items: TabItem[];
  label?: string;
  className?: string;
}) {
  return (
    <nav
      aria-label={label}
      className={cn("overflow-x-auto border-b", className)}
    >
      <div role="tablist" className="flex min-w-max gap-1">
        {items.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            role="tab"
            aria-selected={item.active ?? false}
            className={cn(
              "min-h-11 border-b-2 border-transparent px-3 py-2 text-sm font-medium text-[var(--foreground-secondary)] hover:text-[var(--foreground)]",
              item.active && "border-[var(--primary)] text-[var(--primary)]",
            )}
          >
            {item.label}
          </Link>
        ))}
      </div>
    </nav>
  );
}
