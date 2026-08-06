"use client";

import React, { useEffect, useRef } from "react";
import { Alert } from "@/components/ui/alert";

export type ActionFeedbackValue = {
  tone: "success" | "danger" | "info";
  message: string;
  errorCode?: string;
};

export function ActionFeedback({
  value,
  focusOnError = false,
}: {
  value: ActionFeedbackValue | null;
  focusOnError?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (value?.tone === "danger" && focusOnError) ref.current?.focus();
  }, [focusOnError, value]);

  if (!value) return null;

  return (
    <div ref={ref} tabIndex={-1}>
      <Alert tone={value.tone === "danger" ? "danger" : value.tone}>
        <span>{value.message}</span>
        {value.errorCode ? (
          <details className="mt-2 text-xs">
            <summary className="cursor-pointer">Detalhes técnicos</summary>
            <code>{value.errorCode}</code>
          </details>
        ) : null}
      </Alert>
    </div>
  );
}
