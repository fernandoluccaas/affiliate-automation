"use client";

import React, { useMemo, useRef, useState, useTransition } from "react";
import { FileSearch, FlaskConical, ShieldAlert } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox, Switch } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  inspectShopeeDatafeedAction,
  previewShopeeDatafeedAction,
} from "@/lib/shopee-datafeed-actions";
import type {
  ShopeeDashboardConfigurationDto,
  ShopeeDatafeedActionInput,
  ShopeeInspectActionResult,
  ShopeePreviewActionResult,
} from "./shopee-types";

type Tab =
  | "overview"
  | "datafeeds"
  | "discovery"
  | "categories"
  | "links"
  | "diagnostics";

const tabs: Array<{ id: Tab; label: string }> = [
  { id: "overview", label: "Visão geral" },
  { id: "datafeeds", label: "Datafeeds" },
  { id: "discovery", label: "Descoberta" },
  { id: "categories", label: "Categorias" },
  { id: "links", label: "Links" },
  { id: "diagnostics", label: "Diagnósticos" },
];

function numberOrNull(value: string) {
  if (!value.trim()) return null;
  const parsed = Number(value.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

export function ShopeeDatafeedConsole({
  configuration,
}: {
  configuration: ShopeeDashboardConfigurationDto;
}) {
  const [tab, setTab] = useState<Tab>("overview");
  const [files, setFiles] = useState(["", ""]);
  const [categories, setCategories] = useState(configuration.categories);
  const [priceMin, setPriceMin] = useState("");
  const [priceMax, setPriceMax] = useState("");
  const [discountMin, setDiscountMin] = useState("20");
  const [ratingMin, setRatingMin] = useState("4.7");
  const [shopRatingMin, setShopRatingMin] = useState("");
  const [crossBorderAllowed, setCrossBorderAllowed] = useState(false);
  const [forbiddenWords, setForbiddenWords] = useState("");
  const [inspectResult, setInspectResult] =
    useState<ShopeeInspectActionResult | null>(null);
  const [previewResult, setPreviewResult] =
    useState<ShopeePreviewActionResult | null>(null);
  const [isPending, startTransition] = useTransition();
  const activeOperation = useRef(false);

  const input = useMemo<ShopeeDatafeedActionInput>(
    () => ({
      files: files.map((file) => file.trim()).filter(Boolean),
      categories: categories.map((category) => ({
        id: category.id,
        enabled: category.enabled,
        priority: category.priority,
        minPerCategory: category.minPerCategory,
        maxPerCategory: category.maxPerCategory,
      })),
      filters: {
        priceMin: numberOrNull(priceMin),
        priceMax: numberOrNull(priceMax),
        discountMin: numberOrNull(discountMin),
        itemRatingMin: numberOrNull(ratingMin),
        shopRatingMin: numberOrNull(shopRatingMin),
        crossBorderAllowed,
        forbiddenWords: forbiddenWords
          .split(",")
          .map((word) => word.trim())
          .filter(Boolean),
      },
    }),
    [
      categories,
      crossBorderAllowed,
      discountMin,
      files,
      forbiddenWords,
      priceMax,
      priceMin,
      ratingMin,
      shopRatingMin,
    ],
  );

  function execute(kind: "inspect" | "preview") {
    if (activeOperation.current || input.files.length === 0) return;
    activeOperation.current = true;
    startTransition(async () => {
      try {
        if (kind === "inspect") {
          setInspectResult(await inspectShopeeDatafeedAction(input));
          setTab("datafeeds");
        } else {
          setPreviewResult(await previewShopeeDatafeedAction(input));
          setTab("discovery");
        }
      } finally {
        activeOperation.current = false;
      }
    });
  }

  const latestError =
    inspectResult && !inspectResult.ok
      ? inspectResult
      : previewResult && !previewResult.ok
        ? previewResult
        : null;

  return (
    <section aria-busy={isPending} className="grid gap-5">
      <div
        role="tablist"
        aria-label="Seções da integração Shopee"
        className="flex gap-1 overflow-x-auto rounded-[var(--radius-lg)] border bg-[var(--muted)] p-1"
      >
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            onClick={() => setTab(item.id)}
            className={`min-h-10 shrink-0 rounded-[var(--radius-md)] px-3 text-sm font-medium ${tab === item.id ? "bg-[var(--surface)] shadow-sm" : "text-[var(--foreground-secondary)]"}`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === "overview" ? (
        <Card>
          <CardHeader>
            <CardTitle>Operação segura</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 text-sm sm:grid-cols-2">
            <div>
              <span className="text-[var(--muted-foreground)]">Fonte</span>
              <p className="font-medium">LOCAL_FILE</p>
            </div>
            <div>
              <span className="text-[var(--muted-foreground)]">Modo</span>
              <p className="font-medium">{configuration.mode}</p>
            </div>
            <div>
              <span className="text-[var(--muted-foreground)]">
                Último inspect
              </span>
              <p className="font-medium">
                {inspectResult?.ok
                  ? `${inspectResult.data.validRows} linhas válidas`
                  : "Não executado nesta sessão"}
              </p>
            </div>
            <div>
              <span className="text-[var(--muted-foreground)]">
                Último preview
              </span>
              <p className="font-medium">
                {previewResult?.ok
                  ? `${previewResult.data.selected.length} selecionados`
                  : "Não executado nesta sessão"}
              </p>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {tab === "datafeeds" ? (
        <Card>
          <CardHeader>
            <CardTitle>Caminhos locais dos Datafeeds</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            {[0, 1].map((index) => (
              <div key={index} className="grid gap-2">
                <Label htmlFor={`shopee-file-${index}`}>
                  Arquivo {index + 1}
                  {index === 1 ? " (opcional)" : ""}
                </Label>
                <Input
                  id={`shopee-file-${index}`}
                  value={files[index]}
                  onChange={(event) =>
                    setFiles((current) =>
                      current.map((value, position) =>
                        position === index ? event.target.value : value,
                      ),
                    )
                  }
                  placeholder="C:\\caminho\\datafeed.csv"
                />
              </div>
            ))}
            <p className="text-xs text-[var(--muted-foreground)]">
              O navegador envia somente o caminho informado. O arquivo é lido em
              streaming no servidor e não é carregado para a memória do browser.
            </p>
            <Button
              type="button"
              variant="outline"
              loading={isPending}
              loadingLabel="Inspecionando..."
              disabled={
                input.files.length === 0 || configuration.mode !== "DATAFEED"
              }
              onClick={() => execute("inspect")}
            >
              <FileSearch aria-hidden="true" size={16} /> Inspecionar feed
            </Button>
            {inspectResult ? (
              <Alert
                live
                tone={inspectResult.ok ? "success" : "danger"}
                title={
                  inspectResult.ok ? "Inspeção concluída" : "Falha na inspeção"
                }
              >
                {inspectResult.ok
                  ? `${inspectResult.data.rowsProcessed} processadas, ${inspectResult.data.validRows} válidas, ${inspectResult.data.invalidRows} inválidas e ${inspectResult.data.duplicateItems} duplicadas.`
                  : `${inspectResult.message} (${inspectResult.errorCode})`}
              </Alert>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {tab === "discovery" ? (
        <div className="grid gap-5">
          <Card>
            <CardHeader>
              <CardTitle>Filtros conservadores de preview</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {[
                ["Preço mínimo", priceMin, setPriceMin],
                ["Preço máximo", priceMax, setPriceMax],
                ["Desconto mínimo (%)", discountMin, setDiscountMin],
                ["Rating mínimo", ratingMin, setRatingMin],
                ["Shop rating mínimo", shopRatingMin, setShopRatingMin],
              ].map(([label, value, setter]) => (
                <label key={label as string} className="grid gap-2 text-sm">
                  <span className="font-medium">{label as string}</span>
                  <Input
                    inputMode="decimal"
                    value={value as string}
                    onChange={(event) =>
                      (setter as (value: string) => void)(event.target.value)
                    }
                  />
                </label>
              ))}
              <label className="grid gap-2 text-sm sm:col-span-2">
                <span className="font-medium">
                  Palavras proibidas, separadas por vírgula
                </span>
                <Input
                  value={forbiddenWords}
                  onChange={(event) => setForbiddenWords(event.target.value)}
                />
              </label>
              <Checkbox
                label="Permitir cross-border"
                checked={crossBorderAllowed}
                onChange={(event) =>
                  setCrossBorderAllowed(event.target.checked)
                }
              />
              <div className="sm:col-span-2 lg:col-span-3">
                <Button
                  type="button"
                  loading={isPending}
                  loadingLabel="Processando preview..."
                  disabled={
                    input.files.length === 0 ||
                    configuration.mode !== "DATAFEED"
                  }
                  onClick={() => execute("preview")}
                >
                  <FlaskConical aria-hidden="true" size={16} />
                  Executar preview
                </Button>
              </div>
            </CardContent>
          </Card>
          {previewResult ? (
            <Alert
              live
              tone={previewResult.ok ? "success" : "danger"}
              title={
                previewResult.ok
                  ? "Preview concluído sem gravações"
                  : "Falha no preview"
              }
            >
              {previewResult.ok
                ? `${previewResult.data.selected.length} vencedores em round robin; ${previewResult.data.databaseWrites} escritas, ${previewResult.data.publicationsCreated} Publications e ${previewResult.data.messagesSent} mensagens.`
                : `${previewResult.message} (${previewResult.errorCode})`}
            </Alert>
          ) : null}
          {previewResult?.ok ? (
            <div className="grid gap-3 md:grid-cols-2">
              {previewResult.data.selected.map((candidate, index) => (
                <Card key={candidate.itemId}>
                  <CardContent className="grid gap-2 pt-5 sm:pt-6">
                    <div className="flex items-start justify-between gap-3">
                      <span className="text-xs font-semibold text-[var(--primary)]">
                        #{index + 1} · {candidate.category}
                      </span>
                      <StatusBadge
                        status={
                          candidate.linkStatus === "VERIFIED"
                            ? "ACTIVE"
                            : "WARNING"
                        }
                        label={
                          candidate.linkStatus === "VERIFIED"
                            ? "Verificado"
                            : "Não verificado"
                        }
                      />
                    </div>
                    <h3 className="font-semibold">{candidate.title}</h3>
                    <p className="text-sm">
                      R$ {candidate.salePrice.toFixed(2)} · score{" "}
                      {candidate.score.toFixed(2)}
                    </p>
                    <p className="text-xs text-[var(--muted-foreground)]">
                      {candidate.sourceProductHost} ·{" "}
                      {candidate.sources.join(" + ")}
                    </p>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {tab === "categories" ? (
        <div className="grid gap-3 md:grid-cols-2">
          {categories.map((category) => (
            <Card key={category.id}>
              <CardContent className="grid gap-3 pt-5 sm:pt-6">
                <Switch
                  label={category.label}
                  description={category.id}
                  checked={category.enabled}
                  onChange={(event) =>
                    setCategories((current) =>
                      current.map((item) =>
                        item.id === category.id
                          ? { ...item, enabled: event.target.checked }
                          : item,
                      ),
                    )
                  }
                />
                <p className="text-xs text-[var(--muted-foreground)]">
                  {category.matches
                    .map(
                      (match) =>
                        `${match.category1}${match.category2 ? ` > ${match.category2}` : ""}`,
                    )
                    .join("; ")}
                </p>
                <div className="grid grid-cols-3 gap-2">
                  {(
                    ["priority", "minPerCategory", "maxPerCategory"] as const
                  ).map((field) => (
                    <label key={field} className="grid gap-1 text-xs">
                      <span>
                        {field === "priority"
                          ? "Prioridade"
                          : field === "minPerCategory"
                            ? "Mínimo"
                            : "Máximo"}
                      </span>
                      <Input
                        type="number"
                        value={category[field]}
                        onChange={(event) =>
                          setCategories((current) =>
                            current.map((item) =>
                              item.id === category.id
                                ? {
                                    ...item,
                                    [field]: Number(event.target.value),
                                  }
                                : item,
                            ),
                          )
                        }
                      />
                    </label>
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : null}

      {tab === "links" ? (
        <Alert
          tone={configuration.linksVerified ? "success" : "warning"}
          title="Link fornecido pelo Datafeed"
        >
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge
              status={configuration.linksVerified ? "ACTIVE" : "WARNING"}
              label={
                configuration.linksVerified ? "VERIFICADO" : "NÃO VERIFICADO"
              }
            />
            <span>
              {configuration.linksVerified
                ? "O gate foi habilitado explicitamente, mas a fase continua preview-only."
                : "Atribuição ainda não verificada. O shortlink não é um AffiliateLink confirmado."}
            </span>
          </div>
        </Alert>
      ) : null}

      {tab === "diagnostics" ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldAlert aria-hidden="true" size={18} />
              Diagnósticos sanitizados
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm">
            <p>Parser streaming: csv-parse</p>
            <p>Schemas reconhecidos: OFFICIAL_BR e BRAZIL</p>
            <p>Open API e REMOTE_URL: fail-closed</p>
            {inspectResult?.ok ? (
              <p>
                Erros por código:{" "}
                {JSON.stringify(inspectResult.data.issuesByCode)}
              </p>
            ) : null}
            {previewResult?.ok ? (
              <p>
                Conflitos por código:{" "}
                {JSON.stringify(previewResult.data.conflictsByCode)}
              </p>
            ) : null}
            {latestError ? (
              <Alert tone="danger" title={latestError.errorCode}>
                {latestError.message}
              </Alert>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </section>
  );
}
