"use client";

import { Check, Copy } from "lucide-react";
import React, { useState } from "react";
import { Button } from "@/components/ui/button";

export function CopyButton({
  value,
  label = "Copiar",
  copiedLabel = "Copiado",
}: {
  value: string;
  label?: string;
  copiedLabel?: string;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={copy}
      aria-label={`${label}: ${value}`}
    >
      {copied ? (
        <Check aria-hidden="true" size={14} />
      ) : (
        <Copy aria-hidden="true" size={14} />
      )}
      {copied ? copiedLabel : label}
    </Button>
  );
}
