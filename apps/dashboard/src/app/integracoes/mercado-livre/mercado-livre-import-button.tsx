"use client";

import { useFormStatus } from "react-dom";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

export function MercadoLivreImportButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();

  return (
    <Button
      type="submit"
      variant="outline"
      disabled={disabled || pending}
      aria-live="polite"
    >
      <RefreshCw
        aria-hidden="true"
        size={16}
        className={pending ? "animate-spin" : undefined}
      />
      {pending
        ? "Importando, resolvendo e gerando links..."
        : "Importar mais vendidos e gerar links"}
    </Button>
  );
}
