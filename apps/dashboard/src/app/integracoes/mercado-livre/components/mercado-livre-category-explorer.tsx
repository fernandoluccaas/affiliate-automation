"use client";

import { Plus, Search } from "lucide-react";
import React, { useReducer, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/empty-state";
import { Input } from "@/components/ui/input";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  addMercadoLivreCategoryInteractiveAction,
  getMercadoLivreCategoryChildrenAction,
  testMercadoLivreCategoryInteractiveAction,
} from "@/lib/mercadolivre-interactive-actions";
import type {
  MercadoLivreCategoryBrowserDto,
  MercadoLivreCategoryDto,
  MercadoLivreCategoryTestDto,
  MercadoLivreConfiguredCategoryDto,
} from "../mercado-livre-interactive-types";
import { ActionFeedback, type ActionFeedbackValue } from "./action-feedback";

type Snapshot = Pick<State, "currentCategory" | "children">;
type State = MercadoLivreCategoryBrowserDto & {
  history: Snapshot[];
  pendingOperation: string | null;
  feedback: ActionFeedbackValue | null;
  testResult: MercadoLivreCategoryTestDto | null;
};

type Action =
  | { type: "PENDING"; operation: string }
  | {
      type: "NAVIGATED";
      data: MercadoLivreCategoryBrowserDto;
      previous: Snapshot;
    }
  | { type: "RESTORE"; snapshot: Snapshot }
  | { type: "FAILED"; feedback: ActionFeedbackValue }
  | { type: "TESTED"; result: MercadoLivreCategoryTestDto; message: string }
  | {
      type: "ADDED";
      categories: MercadoLivreConfiguredCategoryDto[];
      message: string;
    };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "PENDING":
      return { ...state, pendingOperation: action.operation, feedback: null };
    case "NAVIGATED":
      return {
        ...state,
        ...action.data,
        history: [...state.history, action.previous],
        pendingOperation: null,
        feedback: null,
      };
    case "RESTORE":
      return {
        ...state,
        ...action.snapshot,
        history: state.history.slice(0, -1),
        pendingOperation: null,
        feedback: null,
      };
    case "FAILED":
      return { ...state, pendingOperation: null, feedback: action.feedback };
    case "TESTED":
      return {
        ...state,
        pendingOperation: null,
        testResult: action.result,
        feedback: { tone: "success", message: action.message },
      };
    case "ADDED":
      return {
        ...state,
        pendingOperation: null,
        configuredCategories: action.categories,
        feedback: { tone: "success", message: action.message },
      };
  }
}

function categoryPath(category: MercadoLivreCategoryDto | null) {
  return (
    category?.path.map((item) => item.name).join(" > ") ||
    "Categorias principais MLB"
  );
}

function TestResults({ result }: { result: MercadoLivreCategoryTestDto }) {
  const rows: Array<[string, string | number]> = [
    ["Nome", result.category.name],
    ["ID", result.category.id],
    ["Caminho", categoryPath(result.category)],
    ["Categoria folha", result.category.isLeaf ? "sim" : "não"],
    ["Subcategorias", result.category.childrenCount],
    ["Highlights disponíveis", result.highlightsAvailable ? "sim" : "não"],
    ["Candidatos", result.candidatesFound],
    ["ITEM", result.highlightItemCount],
    ["PRODUCT", result.highlightProductCount],
    ["USER_PRODUCT", result.highlightUserProductCount],
    ["Tipo desconhecido", result.highlightUnknownTypeCount],
    ["Resolvidos", result.resolvedItemCandidates],
    ["Não resolvidos", result.unresolvedCandidates],
    ["Motivos", result.resolutionReasons || "-"],
    ["Highlights", result.highlightsReason || "-"],
  ];
  return (
    <dl
      className="grid gap-2 rounded-md border bg-[var(--background)] p-3"
      aria-label="Resultado do teste da categoria"
    >
      {rows.map(([label, value]) => (
        <div
          key={label}
          className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 text-sm"
        >
          <dt className="text-[var(--muted-foreground)]">{label}</dt>
          <dd className="text-right font-medium">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function MercadoLivreCategoryExplorer({
  initialData,
}: {
  initialData: MercadoLivreCategoryBrowserDto;
}) {
  const [state, dispatch] = useReducer(reducer, {
    ...initialData,
    history: [],
    pendingOperation: null,
    feedback: null,
    testResult: null,
  });
  const [testCategoryId, setTestCategoryId] = useState(
    initialData.currentCategory?.id ?? "",
  );
  const [, startTransition] = useTransition();
  const requestSequence = useRef(0);
  const exclusiveOperation = useRef(false);
  const configuredIds = new Set(
    state.configuredCategories.map((category) => category.id),
  );

  function fail(errorCode: string, message: string) {
    dispatch({
      type: "FAILED",
      feedback: { tone: "danger", errorCode, message },
    });
  }

  function navigate(categoryId: string | null) {
    const sequence = ++requestSequence.current;
    const previous = {
      currentCategory: state.currentCategory,
      children: state.children,
    };
    dispatch({
      type: "PENDING",
      operation: `navigate:${categoryId ?? "root"}`,
    });
    startTransition(async () => {
      const result = await getMercadoLivreCategoryChildrenAction({
        categoryId,
      });
      if (sequence !== requestSequence.current) return;
      if (!result.ok) return fail(result.errorCode, result.message);
      dispatch({ type: "NAVIGATED", data: result.data, previous });
      setTestCategoryId(result.data.currentCategory?.id ?? "");
    });
  }

  function goBack() {
    requestSequence.current += 1;
    const snapshot = state.history.at(-1);
    if (snapshot) {
      dispatch({ type: "RESTORE", snapshot });
      setTestCategoryId(snapshot.currentCategory?.id ?? "");
    } else navigate(null);
  }

  function addCategory(categoryId: string) {
    if (exclusiveOperation.current) return;
    exclusiveOperation.current = true;
    dispatch({ type: "PENDING", operation: `add:${categoryId}` });
    startTransition(async () => {
      try {
        const result = await addMercadoLivreCategoryInteractiveAction({
          categoryId,
        });
        if (!result.ok) return fail(result.errorCode, result.message);
        dispatch({
          type: "ADDED",
          categories: result.data.configuredCategories,
          message: result.message,
        });
        window.dispatchEvent(
          new CustomEvent("mercadolivre:category-added", {
            detail: result.data.category,
          }),
        );
      } finally {
        exclusiveOperation.current = false;
      }
    });
  }

  function testCategory() {
    if (exclusiveOperation.current) return;
    exclusiveOperation.current = true;
    dispatch({ type: "PENDING", operation: "test-category" });
    startTransition(async () => {
      try {
        const result = await testMercadoLivreCategoryInteractiveAction({
          categoryId: testCategoryId,
        });
        if (!result.ok) return fail(result.errorCode, result.message);
        dispatch({
          type: "TESTED",
          result: result.data,
          message: result.message,
        });
      } finally {
        exclusiveOperation.current = false;
      }
    });
  }

  const currentLeaf = state.currentCategory?.isLeaf === true;
  return (
    <div
      className="grid gap-4 lg:grid-cols-[1.5fr_1fr]"
      data-testid="category-explorer-shell"
    >
      <Card
        id="categorias"
        className="scroll-mt-24"
        aria-busy={state.pendingOperation?.startsWith("navigate:") || undefined}
      >
        <CardHeader>
          <CardTitle>Seletor de categorias</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <nav
            aria-label="Caminho da categoria"
            className="rounded-md border bg-[var(--background)] p-3 text-sm"
          >
            <ol className="flex flex-wrap items-center gap-2">
              <li>
                <button
                  type="button"
                  className="font-medium hover:underline"
                  onClick={() => navigate(null)}
                >
                  Categorias principais MLB
                </button>
              </li>
              {state.currentCategory?.path.map((item, index) => (
                <li key={item.id} className="flex items-center gap-2">
                  <span aria-hidden="true">/</span>
                  {index === state.currentCategory!.path.length - 1 ? (
                    <span aria-current="page">{item.name}</span>
                  ) : (
                    <button
                      type="button"
                      className="hover:underline"
                      onClick={() => navigate(item.id)}
                    >
                      {item.name}
                    </button>
                  )}
                </li>
              ))}
            </ol>
            {state.currentCategory ? (
              <p className="mt-2 font-mono text-xs text-[var(--muted-foreground)]">
                {state.currentCategory.id}
              </p>
            ) : null}
          </nav>

          {state.currentCategory ? (
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" onClick={goBack}>
                Voltar um nível
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => navigate(null)}
              >
                Categorias principais
              </Button>
            </div>
          ) : null}

          {state.children.length === 0 ? (
            currentLeaf && state.currentCategory ? (
              <div className="grid gap-4 rounded-[var(--radius-lg)] border bg-[var(--primary-subtle)] p-5">
                <div>
                  <StatusBadge status="ACTIVE" label="Categoria folha" />
                  <h3 className="mt-3 text-lg font-semibold">
                    {state.currentCategory.name}
                  </h3>
                </div>
                {configuredIds.has(state.currentCategory.id) ? (
                  <StatusBadge
                    status="SUCCEEDED"
                    label="Categoria adicionada"
                  />
                ) : (
                  <Button
                    type="button"
                    onClick={() => addCategory(state.currentCategory!.id)}
                    loading={
                      state.pendingOperation ===
                      `add:${state.currentCategory.id}`
                    }
                    loadingLabel="Adicionando categoria…"
                  >
                    <Plus aria-hidden="true" size={16} />
                    Adicionar categoria
                  </Button>
                )}
              </div>
            ) : (
              <EmptyState
                title="Nenhuma subcategoria disponível"
                description="Volte ao nível anterior para escolher outra categoria."
              />
            )
          ) : (
            <div className="grid gap-3">
              {state.children.map((category) => (
                <div
                  key={category.id}
                  className="grid gap-3 rounded-md border bg-[var(--surface)] p-4 md:grid-cols-[1fr_auto]"
                >
                  <div>
                    <div className="font-medium">{category.name}</div>
                    <div className="mt-1 text-xs text-[var(--muted-foreground)]">
                      {categoryPath(category)}
                    </div>
                    <div className="mt-1 font-mono text-xs text-[var(--muted-foreground)]">
                      {category.id}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {category.isLeaf ? (
                      configuredIds.has(category.id) ? (
                        <StatusBadge
                          status="SUCCEEDED"
                          label="Categoria adicionada"
                        />
                      ) : (
                        <Button
                          type="button"
                          onClick={() => addCategory(category.id)}
                          loading={
                            state.pendingOperation === `add:${category.id}`
                          }
                          loadingLabel="Adicionando…"
                        >
                          <Plus aria-hidden="true" size={16} />
                          Adicionar categoria
                        </Button>
                      )
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => navigate(category.id)}
                        loading={
                          state.pendingOperation === `navigate:${category.id}`
                        }
                        loadingLabel="Abrindo subcategorias…"
                      >
                        Abrir subcategorias
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          <ActionFeedback value={state.feedback} focusOnError />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Testar categoria</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 text-sm">
          <label className="grid gap-2">
            <span className="font-medium">ID da categoria</span>
            <Input
              value={testCategoryId}
              onChange={(event) => setTestCategoryId(event.target.value)}
              placeholder="MLB123456"
            />
          </label>
          <Button
            type="button"
            variant="outline"
            onClick={testCategory}
            loading={state.pendingOperation === "test-category"}
            loadingLabel="Testando categoria…"
            disabled={!testCategoryId.trim()}
          >
            <Search aria-hidden="true" size={16} />
            Testar categoria
          </Button>
          <div aria-live="polite" aria-atomic="true">
            {state.pendingOperation === "test-category" ? (
              <p role="status">Testando categoria…</p>
            ) : null}
            {state.testResult ? (
              <TestResults result={state.testResult} />
            ) : null}
          </div>
          {state.testResult?.category.isLeaf &&
          !configuredIds.has(state.testResult.category.id) ? (
            <Button
              type="button"
              onClick={() => addCategory(state.testResult!.category.id)}
            >
              <Plus aria-hidden="true" size={16} />
              Adicionar categoria testada
            </Button>
          ) : null}
          <div className="grid gap-2" aria-live="polite">
            <h3 className="font-medium">Categorias configuradas</h3>
            {state.configuredCategories.length === 0 ? (
              <p className="text-[var(--muted-foreground)]">
                Nenhuma categoria configurada.
              </p>
            ) : (
              state.configuredCategories.map((category) => (
                <div key={category.id} className="rounded-md border p-3">
                  <div className="font-medium">{category.name}</div>
                  <div className="text-xs text-[var(--muted-foreground)]">
                    {category.id}
                  </div>
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
