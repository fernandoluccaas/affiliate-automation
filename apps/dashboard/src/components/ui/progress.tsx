import React from "react";

export function Progress({ value, label }: { value: number; label: string }) {
  const safe = Math.min(100, Math.max(0, value));
  return (
    <div className="grid gap-1.5">
      <div className="flex justify-between gap-3 text-xs">
        <span>{label}</span>
        <span className="tabular-nums">{safe}%</span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={safe}
        className="h-2 overflow-hidden rounded-full bg-[var(--muted)]"
      >
        <div
          className="h-full rounded-full bg-[var(--primary)]"
          style={{ width: `${safe}%` }}
        />
      </div>
    </div>
  );
}

export function Skeleton({ className = "h-4 w-full" }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`block animate-pulse rounded-md bg-[var(--muted)] ${className}`}
    />
  );
}
