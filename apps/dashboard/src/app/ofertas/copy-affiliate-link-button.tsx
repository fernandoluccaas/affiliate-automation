"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

export function CopyAffiliateLinkButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2_000);
  }

  return (
    <Button type="button" variant="outline" onClick={copy}>
      {copied ? "Copiado" : "Copiar link"}
    </Button>
  );
}
