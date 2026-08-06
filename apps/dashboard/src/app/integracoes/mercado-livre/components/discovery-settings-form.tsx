"use client";

import { Save } from "lucide-react";
import React, { useEffect, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { saveMercadoLivreConfigInteractiveAction } from "@/lib/mercadolivre-interactive-actions";
import type {
  MercadoLivreConfiguredCategoryDto,
  MercadoLivreDiscoveryConfigDto,
} from "../mercado-livre-interactive-types";
import { ActionFeedback, type ActionFeedbackValue } from "./action-feedback";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="grid gap-2 text-sm">
      <span className="font-medium">{label}</span>
      {children}
    </label>
  );
}

export function DiscoverySettingsForm({
  initialConfig,
}: {
  initialConfig: MercadoLivreDiscoveryConfigDto;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [categories, setCategories] = useState(initialConfig.categories);
  const [categoryIds, setCategoryIds] = useState(
    initialConfig.categories.map((category) => category.id).join(", "),
  );
  const [dirty, setDirty] = useState(false);
  const [feedback, setFeedback] = useState<ActionFeedbackValue | null>(null);
  const [pending, startTransition] = useTransition();
  const pendingRef = useRef(false);

  useEffect(() => {
    function onCategoryAdded(event: Event) {
      const category = (event as CustomEvent<MercadoLivreConfiguredCategoryDto>)
        .detail;
      setCategories((current) =>
        current.some((entry) => entry.id === category.id)
          ? current
          : [...current, category],
      );
      setCategoryIds((current) =>
        current
          .split(",")
          .map((id) => id.trim())
          .includes(category.id)
          ? current
          : [current, category.id].filter(Boolean).join(", "),
      );
      setDirty(true);
    }
    window.addEventListener("mercadolivre:category-added", onCategoryAdded);
    return () =>
      window.removeEventListener(
        "mercadolivre:category-added",
        onCategoryAdded,
      );
  }, []);

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pendingRef.current) return;
    pendingRef.current = true;
    const formData = new FormData(event.currentTarget);
    setFeedback(null);
    startTransition(async () => {
      try {
        const result = await saveMercadoLivreConfigInteractiveAction(formData);
        if (!result.ok) {
          setFeedback({
            tone: "danger",
            message: result.message,
            errorCode: result.errorCode,
          });
          return;
        }
        setCategories(result.data.categories);
        setCategoryIds(
          result.data.categories.map((category) => category.id).join(", "),
        );
        setDirty(false);
        setFeedback({ tone: "success", message: result.message });
      } finally {
        pendingRef.current = false;
      }
    });
  }

  return (
    <form
      ref={formRef}
      onSubmit={submit}
      onChange={() => setDirty(true)}
      className="grid gap-4"
      aria-busy={pending}
    >
      <div
        className="flex flex-wrap items-center justify-between gap-2"
        aria-live="polite"
      >
        <span className="text-sm text-[var(--muted-foreground)]">
          {dirty ? "Alterações não salvas" : "Configuração sincronizada"}
        </span>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          name="enabled"
          type="checkbox"
          defaultChecked={initialConfig.enabled}
        />
        Integração ativa
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          name="bestSellersEnabled"
          type="checkbox"
          defaultChecked={initialConfig.bestSellersEnabled}
        />
        Usar ranking oficial de mais vendidos
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          name="multiCategoryEnabled"
          type="checkbox"
          defaultChecked={initialConfig.multiCategoryEnabled}
        />
        Habilitar seleção multicategoria balanceada
      </label>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Site ID">
          <Input name="siteId" defaultValue={initialConfig.siteId} />
        </Field>
        <Field label="Máximo por categoria">
          <Input
            name="maxCandidatesPerCategory"
            type="number"
            min={1}
            max={20}
            defaultValue={initialConfig.maxCandidatesPerCategory}
          />
        </Field>
        <Field label="Preço mínimo">
          <Input
            name="minimumPrice"
            inputMode="decimal"
            defaultValue={initialConfig.minimumPrice}
          />
        </Field>
        <Field label="Preço máximo">
          <Input
            name="maximumPrice"
            inputMode="decimal"
            defaultValue={initialConfig.maximumPrice}
          />
        </Field>
        <Field label="Desconto mínimo (%)">
          <Input
            name="minimumDiscountPercentage"
            inputMode="decimal"
            defaultValue={initialConfig.minimumDiscountPercentage}
          />
        </Field>
        <Field label="Score mínimo">
          <Input
            name="minimumScore"
            type="number"
            min={0}
            max={100}
            defaultValue={initialConfig.minimumScore}
          />
        </Field>
        <Field label="Intervalo de refresh (min)">
          <Input
            name="refreshIntervalMinutes"
            type="number"
            min={15}
            defaultValue={initialConfig.refreshIntervalMinutes}
          />
        </Field>
        <Field label="Mínimo de ofertas por categoria">
          <Input
            name="multiCategoryMinOffersPerCategory"
            type="number"
            min={0}
            max={2}
            defaultValue={initialConfig.multiCategoryMinOffersPerCategory}
          />
        </Field>
        <Field label="Máximo de ofertas por categoria">
          <Input
            name="multiCategoryMaxOffersPerCategory"
            type="number"
            min={1}
            max={10}
            defaultValue={initialConfig.multiCategoryMaxOffersPerCategory}
          />
        </Field>
        <Field label="Máximo total por sessão">
          <Input
            name="multiCategoryMaxTotalPerSession"
            type="number"
            min={1}
            max={100}
            defaultValue={initialConfig.multiCategoryMaxTotalPerSession}
          />
        </Field>
        <Field label="Modo de seleção">
          <Select
            name="multiCategorySelectionMode"
            defaultValue={initialConfig.multiCategorySelectionMode}
          >
            <option value="ROUND_ROBIN">Round robin</option>
          </Select>
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          name="multiCategoryAllowCategoryBackfill"
          type="checkbox"
          defaultChecked={initialConfig.multiCategoryAllowCategoryBackfill}
        />
        Permitir backfill controlado entre categorias
      </label>
      <details className="rounded-md border bg-[var(--background)] px-4">
        <summary className="cursor-pointer font-medium">
          Opções avançadas
        </summary>
        <div className="border-t py-4">
          <Field label="IDs de categorias">
            <Textarea
              name="categoryIds"
              value={categoryIds}
              onChange={(event) => {
                setCategoryIds(event.target.value);
                setDirty(true);
              }}
            />
          </Field>
        </div>
      </details>
      {categories.length > 0 ? (
        <div
          id="categorias-configuradas"
          className="scroll-mt-24 overflow-x-auto rounded-md border"
        >
          <table className="w-full text-left text-sm">
            <thead className="bg-[var(--muted)]">
              <tr>
                <th className="p-2">Ativa</th>
                <th className="p-2">Categoria oficial</th>
                <th className="p-2">Prioridade</th>
                <th className="p-2">Mínimo</th>
                <th className="p-2">Máximo</th>
              </tr>
            </thead>
            <tbody>
              {categories.map((category) => (
                <tr key={category.id} className="border-t">
                  <td className="p-2">
                    <input
                      aria-label={`Habilitar ${category.id}`}
                      name={`categoryEnabled:${category.id}`}
                      type="checkbox"
                      defaultChecked={category.enabled}
                    />
                  </td>
                  <td className="p-2">
                    <span className="font-medium">{category.name}</span>
                    <span className="block text-xs text-[var(--muted-foreground)]">
                      {category.id} · categoria folha
                    </span>
                  </td>
                  <td className="p-2">
                    <Input
                      aria-label={`Prioridade ${category.id}`}
                      name={`categoryPriority:${category.id}`}
                      type="number"
                      min={-100}
                      max={100}
                      defaultValue={category.priority}
                    />
                  </td>
                  <td className="p-2">
                    <Input
                      aria-label={`Mínimo ${category.id}`}
                      name={`categoryMin:${category.id}`}
                      type="number"
                      min={0}
                      max={2}
                      defaultValue={category.minOffers ?? ""}
                      placeholder="global"
                    />
                  </td>
                  <td className="p-2">
                    <Input
                      aria-label={`Máximo ${category.id}`}
                      name={`categoryMax:${category.id}`}
                      type="number"
                      min={1}
                      max={10}
                      defaultValue={category.maxOffers ?? ""}
                      placeholder="global"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <ActionFeedback value={feedback} focusOnError />
      <Button
        type="submit"
        loading={pending}
        loadingLabel="Salvando configuração…"
      >
        <Save aria-hidden="true" size={16} />
        Salvar configuração
      </Button>
    </form>
  );
}
