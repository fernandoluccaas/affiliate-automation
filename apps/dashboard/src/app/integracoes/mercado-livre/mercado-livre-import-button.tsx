"use client";

import { RefreshCw } from "lucide-react";
import React, { useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { syncMercadoLivreNowInteractiveAction } from "@/lib/mercadolivre-interactive-actions";
import type { MercadoLivreImportSummaryDto } from "./mercado-livre-interactive-types";
import {
  ActionFeedback,
  type ActionFeedbackValue,
} from "./components/action-feedback";

export function MercadoLivreImportButton({ disabled }: { disabled: boolean }) {
  const [pending, startTransition] = useTransition();
  const pendingRef = useRef(false);
  const [feedback, setFeedback] = useState<ActionFeedbackValue | null>(null);
  const [summary, setSummary] = useState<MercadoLivreImportSummaryDto | null>(
    null,
  );

  function run() {
    if (disabled || pendingRef.current) return;
    pendingRef.current = true;
    setFeedback(null);
    startTransition(async () => {
      try {
        const result = await syncMercadoLivreNowInteractiveAction();
        if (!result.ok) {
          setFeedback({
            tone: "danger",
            message: result.message,
            errorCode: result.errorCode,
          });
          return;
        }
        setSummary(result.data);
        setFeedback({ tone: "success", message: result.message });
      } finally {
        pendingRef.current = false;
      }
    });
  }

  return (
    <div className="grid gap-2">
      <Button
        type="button"
        variant="outline"
        disabled={disabled}
        loading={pending}
        loadingLabel="Importando, resolvendo e gerando links…"
        onClick={run}
      >
        <RefreshCw aria-hidden="true" size={16} />
        Importar mais vendidos e gerar links
      </Button>
      {summary ? (
        <p
          className="text-xs text-[var(--muted-foreground)]"
          aria-live="polite"
        >
          {summary.candidatesFound} encontrados · {summary.newOfferVersions}{" "}
          ofertas novas · {summary.updatedOffers} atualizadas ·{" "}
          {summary.readyForAffiliateLink} aguardando link
        </p>
      ) : null}
      <ActionFeedback value={feedback} focusOnError />
    </div>
  );
}
