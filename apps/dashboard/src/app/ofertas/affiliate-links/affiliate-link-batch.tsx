"use client";

import { useMemo, useState } from "react";
import type {
  AffiliateLinkBatchPreview,
  ApplyAffiliateLinksBatchResult,
} from "@affiliate/marketplace-discovery";
import {
  applyAffiliateLinksBatchAction,
  previewAffiliateLinksBatchAction,
  type AffiliateLinkBatchActionInput,
} from "@/lib/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type QuickOffer = {
  id: string;
  externalProductId: string;
  title: string;
  marketplace: string;
  currentPrice: string;
  productUrl: string;
  status: string;
};

type AffiliateLinkBatchProps = {
  offers: QuickOffer[];
};

function previewLabel(status: string) {
  if (status === "VALID") return "Válido";
  if (status === "NOT_FOUND") return "Não encontrado";
  if (status === "DUPLICATE") return "Duplicado";
  if (status === "INVALID_LINK") return "Link inválido";
  return "Já atualizado";
}

export function AffiliateLinkBatch({ offers }: AffiliateLinkBatchProps) {
  const [quickLinks, setQuickLinks] = useState<Record<string, string>>({});
  const [pipeText, setPipeText] = useState("");
  const [csvText, setCsvText] = useState("");
  const [preview, setPreview] = useState<AffiliateLinkBatchPreview | null>(
    null,
  );
  const [parseIssues, setParseIssues] = useState<
    Array<{ line: number; message: string }>
  >([]);
  const [result, setResult] = useState<ApplyAffiliateLinksBatchResult | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [pendingInput, setPendingInput] =
    useState<AffiliateLinkBatchActionInput | null>(null);

  const quickEntries = useMemo(
    () =>
      offers.flatMap((offer, index) => {
        const affiliateUrl = quickLinks[offer.id]?.trim();

        return affiliateUrl
          ? [
              {
                line: index + 1,
                externalId: offer.externalProductId,
                productUrl: offer.productUrl,
                affiliateUrl,
              },
            ]
          : [];
      }),
    [offers, quickLinks],
  );

  async function runPreview(input: AffiliateLinkBatchActionInput) {
    setBusy(true);
    setResult(null);

    try {
      const response = await previewAffiliateLinksBatchAction(input);
      setParseIssues(response.parseIssues);
      setPreview(response.preview);
      setPendingInput(input);
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!pendingInput || !preview || preview.counts.valid === 0) return;
    setBusy(true);

    try {
      const response = await applyAffiliateLinksBatchAction(pendingInput);
      setParseIssues(response.parseIssues);
      setResult(response.result);
      if (response.ok) setPreview(null);
    } finally {
      setBusy(false);
    }
  }

  async function loadCsv(file?: File) {
    setCsvText(file ? await file.text() : "");
    setPreview(null);
    setResult(null);
  }

  return (
    <div className="grid gap-6">
      <section className="rounded-md border bg-white p-4">
        <h2 className="font-semibold">Método A — edição rápida</h2>
        <p className="mt-1 text-sm text-[var(--muted-foreground)]">
          Cole vários links na tabela e pré-visualize antes de confirmar.
        </p>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[920px] text-left text-sm">
            <thead className="border-b bg-[var(--muted)] text-xs uppercase">
              <tr>
                <th className="px-3 py-2">Produto</th>
                <th className="px-3 py-2">Marketplace</th>
                <th className="px-3 py-2">ID externo</th>
                <th className="px-3 py-2">Preço</th>
                <th className="px-3 py-2">URL original</th>
                <th className="px-3 py-2">Link de afiliado</th>
                <th className="px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {offers.map((offer) => (
                <tr key={offer.id} className="border-b align-top">
                  <td className="max-w-[240px] px-3 py-2">{offer.title}</td>
                  <td className="px-3 py-2">Mercado Livre</td>
                  <td className="px-3 py-2">{offer.externalProductId}</td>
                  <td className="px-3 py-2">{offer.currentPrice}</td>
                  <td className="px-3 py-2">
                    <a
                      className="text-[var(--primary)] hover:underline"
                      href={offer.productUrl}
                      rel="noreferrer"
                      target="_blank"
                    >
                      abrir
                    </a>
                  </td>
                  <td className="min-w-[300px] px-3 py-2">
                    <Input
                      aria-label={`Link de afiliado de ${offer.externalProductId}`}
                      onChange={(event) =>
                        setQuickLinks((current) => ({
                          ...current,
                          [offer.id]: event.target.value,
                        }))
                      }
                      placeholder="https://meli.la/..."
                      type="url"
                      value={quickLinks[offer.id] ?? ""}
                    />
                  </td>
                  <td className="px-3 py-2">{offer.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Button
          className="mt-4"
          disabled={busy || quickEntries.length === 0}
          onClick={() =>
            runPreview({ method: "ENTRIES", entries: quickEntries })
          }
          type="button"
        >
          Pré-visualizar edição rápida
        </Button>
      </section>

      <section className="grid gap-4 rounded-md border bg-white p-4">
        <div>
          <h2 className="font-semibold">Método B — colagem em lote</h2>
          <p className="mt-1 text-sm text-[var(--muted-foreground)]">
            Use uma linha por produto no formato identificador|affiliateUrl.
          </p>
        </div>
        <textarea
          className="min-h-32 rounded-md border px-3 py-2 font-mono text-sm"
          onChange={(event) => setPipeText(event.target.value)}
          placeholder="MLB1234567890|https://meli.la/abc123"
          value={pipeText}
        />
        <Button
          disabled={busy || !pipeText.trim()}
          onClick={() => runPreview({ method: "PIPE", raw: pipeText })}
          type="button"
        >
          Pré-visualizar colagem
        </Button>
      </section>

      <section className="grid gap-4 rounded-md border bg-white p-4">
        <div>
          <h2 className="font-semibold">Método C — CSV</h2>
          <p className="mt-1 text-sm text-[var(--muted-foreground)]">
            Cabeçalhos: externalId, productUrl, affiliateUrl. Aceita vírgula,
            ponto e vírgula e BOM.
          </p>
        </div>
        <Input
          accept=".csv,text/csv"
          onChange={(event) => loadCsv(event.target.files?.[0])}
          type="file"
        />
        <Button
          disabled={busy || !csvText.trim()}
          onClick={() => runPreview({ method: "CSV", raw: csvText })}
          type="button"
        >
          Pré-visualizar CSV
        </Button>
      </section>

      {parseIssues.length > 0 ? (
        <section className="rounded-md border border-red-300 bg-red-50 p-4">
          <h2 className="font-semibold">Erros de leitura</h2>
          <ul className="mt-2 list-disc pl-5 text-sm">
            {parseIssues.map((issue) => (
              <li key={`${issue.line}-${issue.message}`}>
                Linha {issue.line}: {issue.message}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {preview ? (
        <section className="rounded-md border bg-white p-4">
          <h2 className="font-semibold">Preview</h2>
          <div className="mt-3 grid gap-2 sm:grid-cols-5">
            <div>Válidos: {preview.counts.valid}</div>
            <div>Não encontrados: {preview.counts.notFound}</div>
            <div>Duplicados: {preview.counts.duplicates}</div>
            <div>Link inválido: {preview.counts.invalidLinks}</div>
            <div>Já atualizados: {preview.counts.alreadyUpdated}</div>
          </div>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="border-b">
                <tr>
                  <th className="px-3 py-2">Linha</th>
                  <th className="px-3 py-2">Identificador</th>
                  <th className="px-3 py-2">Link</th>
                  <th className="px-3 py-2">Resultado</th>
                </tr>
              </thead>
              <tbody>
                {preview.items.map((item) => (
                  <tr key={`${item.line}-${item.affiliateUrl}`} className="border-b">
                    <td className="px-3 py-2">{item.line}</td>
                    <td className="px-3 py-2">
                      {item.externalId ?? item.productUrl}
                    </td>
                    <td className="max-w-[320px] break-all px-3 py-2">
                      {item.affiliateUrl}
                    </td>
                    <td className="px-3 py-2">
                      <div>{previewLabel(item.status)}</div>
                      <div className="text-xs text-[var(--muted-foreground)]">
                        {item.message}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Button
            className="mt-4"
            disabled={busy || preview.counts.valid === 0}
            onClick={confirm}
            type="button"
          >
            Confirmar {preview.counts.valid} atualização(ões)
          </Button>
        </section>
      ) : null}

      {result ? (
        <section className="rounded-md border bg-emerald-50 p-4">
          <h2 className="font-semibold">
            {result.status === "QUEUED"
              ? "Lote enfileirado para o worker"
              : "Lote concluído"}
          </h2>
          <div className="mt-2 grid gap-2 sm:grid-cols-3">
            <div>Atualizados: {result.updated}</div>
            <div>Ignorados: {result.ignored}</div>
            <div>Falhas: {result.failed}</div>
            <div>Prontos para publicação: {result.readyToPublish}</div>
            <div>Rejeitados: {result.rejected}</div>
            <div>Ainda pendentes: {result.readyForAffiliateLink}</div>
          </div>
        </section>
      ) : null}
    </div>
  );
}
