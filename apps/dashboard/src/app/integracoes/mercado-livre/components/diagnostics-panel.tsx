"use client";

import React, { useState, useTransition } from "react";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  diagnoseMercadoLivreProductInteractiveAction,
  probeMercadoLivreCategorySearchInteractiveAction,
  testMercadoLivreProductPdpAffiliateInteractiveAction,
} from "@/lib/mercadolivre-interactive-actions";
import type {
  MercadoLivreCategorySearchProbeDto,
  MercadoLivreProductDiagnosticDto,
  MercadoLivreProductPdpAffiliateDiagnosticDto,
} from "../mercado-livre-interactive-types";
import { ActionFeedback, type ActionFeedbackValue } from "./action-feedback";

function Results({
  label,
  rows,
}: {
  label: string;
  rows: Array<[string, string | number | boolean | null]>;
}) {
  return (
    <dl
      aria-label={label}
      className="grid gap-2 rounded-md border bg-[var(--background)] p-3 text-sm"
    >
      {rows.map(([name, value]) => (
        <div
          key={name}
          className="grid gap-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]"
        >
          <dt className="text-[var(--muted-foreground)]">{name}</dt>
          <dd className="break-words font-medium">
            {value === null ? "-" : String(value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function DiagnosticsPanel({
  initialCategoryId = "",
}: {
  initialCategoryId?: string;
}) {
  const [productId, setProductId] = useState("");
  const [categoryId, setCategoryId] = useState(initialCategoryId);
  const [product, setProduct] =
    useState<MercadoLivreProductDiagnosticDto | null>(null);
  const [pdpAffiliate, setPdpAffiliate] =
    useState<MercadoLivreProductPdpAffiliateDiagnosticDto | null>(null);
  const [probe, setProbe] = useState<MercadoLivreCategorySearchProbeDto | null>(
    null,
  );
  const [feedback, setFeedback] = useState<ActionFeedbackValue | null>(null);
  const [pendingOperation, setPendingOperation] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function run(operation: string, callback: () => Promise<void>) {
    if (pendingOperation) return;
    setPendingOperation(operation);
    setFeedback(null);
    startTransition(async () => {
      try {
        await callback();
      } finally {
        setPendingOperation(null);
      }
    });
  }

  function diagnose() {
    run("product", async () => {
      const result = await diagnoseMercadoLivreProductInteractiveAction({
        productId,
      });
      if (!result.ok) {
        setFeedback({
          tone: "danger",
          message: result.message,
          errorCode: result.errorCode,
        });
        return;
      }
      setProduct(result.data);
      setFeedback({ tone: "success", message: result.message });
    });
  }

  function executeProbe() {
    run("probe", async () => {
      const result = await probeMercadoLivreCategorySearchInteractiveAction({
        categoryId,
      });
      if (!result.ok) {
        setFeedback({
          tone: "danger",
          message: result.message,
          errorCode: result.errorCode,
        });
        return;
      }
      setProbe(result.data);
      setFeedback({ tone: "success", message: result.message });
    });
  }

  function testPdpAffiliate() {
    run("pdp-affiliate", async () => {
      const result = await testMercadoLivreProductPdpAffiliateInteractiveAction(
        {
          productId,
        },
      );
      if (!result.ok) {
        setFeedback({
          tone: "danger",
          message: result.message,
          errorCode: result.errorCode,
        });
        return;
      }
      setPdpAffiliate(result.data);
      setFeedback({ tone: "success", message: result.message });
    });
  }

  return (
    <Card id="diagnosticos" className="scroll-mt-24">
      <CardHeader>
        <CardTitle>Diagnósticos Mercado Livre</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-6" aria-busy={Boolean(pendingOperation)}>
        <section
          className="grid gap-3"
          aria-labelledby="product-diagnostic-title"
        >
          <h3 id="product-diagnostic-title" className="font-semibold">
            Diagnosticar PRODUCT
          </h3>
          <p className="text-sm text-[var(--muted-foreground)]">
            Consulta a API oficial sem ingerir ofertas, criar jobs ou gerar
            links.
          </p>
          <label className="grid gap-2 text-sm">
            <span className="font-medium">PRODUCT ID</span>
            <Input
              value={productId}
              onChange={(event) => setProductId(event.target.value)}
              placeholder="MLB62081577"
            />
          </label>
          <Button
            type="button"
            variant="outline"
            className="w-fit"
            onClick={diagnose}
            disabled={!productId.trim()}
            loading={pendingOperation === "product"}
            loadingLabel="Diagnosticando PRODUCT…"
          >
            <Search aria-hidden="true" size={16} />
            Diagnosticar PRODUCT
          </Button>
          <Button
            type="button"
            variant="outline"
            className="w-fit"
            onClick={testPdpAffiliate}
            disabled={!productId.trim()}
            loading={pendingOperation === "pdp-affiliate"}
            loadingLabel="Testando PDP afiliado…"
          >
            Testar geração afiliada do PDP
          </Button>
          <div aria-live="polite">
            {product ? (
              <Results
                label="Resultado do diagnóstico PRODUCT"
                rows={[
                  ["PRODUCT", product.productId],
                  ["Encontrado", product.productFound],
                  ["Status", product.productStatus],
                  ["Nome", product.productName],
                  ["URL resolvida", product.resolvedProductUrl],
                  ["Origem da URL", product.productUrlSource],
                  ["Winner", product.buyBoxWinnerItemId],
                  ["ITEM selecionado", product.selectedItemId],
                  ["Preço", product.selectedPrice],
                  ["Resolução elegível", product.resolutionEligible],
                  ["Fallback PDP elegível", product.pdpFallbackEligible],
                  ["Motivos", product.rejectionReasons.join(", ") || "-"],
                ]}
              />
            ) : null}
          </div>
          <div aria-live="polite">
            {pdpAffiliate ? (
              <Results
                label="Resultado do teste afiliado do PRODUCT"
                rows={[
                  ["PRODUCT", pdpAffiliate.productId],
                  ["Modo", pdpAffiliate.endpointMode],
                  ["Host", pdpAffiliate.affiliateHost],
                  ["É meli.la", pdpAffiliate.startsWithMeliLa],
                  ["Origem da URL", pdpAffiliate.productUrlSource],
                ]}
              />
            ) : null}
          </div>
        </section>

        <section
          className="grid gap-3 border-t pt-5"
          aria-labelledby="category-probe-title"
        >
          <h3 id="category-probe-title" className="font-semibold">
            Probe avançado da categoria
          </h3>
          <p className="text-sm text-[var(--muted-foreground)]">
            Diagnóstico explícito da busca comum. A descoberta normal continua
            usando highlights.
          </p>
          <label className="grid gap-2 text-sm">
            <span className="font-medium">Categoria folha</span>
            <Input
              value={categoryId}
              onChange={(event) => setCategoryId(event.target.value)}
              placeholder="MLB123456"
            />
          </label>
          <Button
            type="button"
            variant="outline"
            className="w-fit"
            onClick={executeProbe}
            disabled={!categoryId.trim()}
            loading={pendingOperation === "probe"}
            loadingLabel="Executando probe…"
          >
            <Search aria-hidden="true" size={16} />
            Executar probe avançado
          </Button>
          <div aria-live="polite">
            {probe ? (
              <Results
                label="Resultado do probe da categoria"
                rows={[
                  ["Categoria", probe.categoryName],
                  ["ID", probe.categoryId],
                  ["Caminho", probe.categoryPath],
                  ["Endpoint lógico", `${probe.method} ${probe.endpoint}`],
                  ["Diagnóstico", probe.diagnosis],
                  ["HTTP autenticado", probe.authenticated.httpStatus],
                  ["Resultados autenticados", probe.authenticated.resultsFound],
                  ["HTTP público", probe.public.httpStatus],
                  ["Resultados públicos", probe.public.resultsFound],
                ]}
              />
            ) : null}
          </div>
        </section>
        <ActionFeedback value={feedback} focusOnError />
      </CardContent>
    </Card>
  );
}
