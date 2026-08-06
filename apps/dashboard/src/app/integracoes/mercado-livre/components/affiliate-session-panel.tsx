"use client";

import React, { useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  clearMercadoLivreAffiliateSessionInteractiveAction,
  generateMercadoLivreAffiliateTestLinkInteractiveAction,
  generatePendingMercadoLivreAffiliateLinksInteractiveAction,
  saveMercadoLivreAffiliateSessionInteractiveAction,
  selectMercadoLivreAffiliateTagInteractiveAction,
  testMercadoLivreAffiliateSessionInteractiveAction,
} from "@/lib/mercadolivre-interactive-actions";
import type {
  MercadoLivreAffiliateLinkTestDto,
  MercadoLivreAffiliateTagDto,
  MercadoLivrePendingLinksDto,
} from "../mercado-livre-interactive-types";
import { ActionFeedback, type ActionFeedbackValue } from "./action-feedback";

export type AffiliateSessionPanelInitialData = {
  oauthConnected: boolean;
  configured: boolean;
  status: string;
  statusLabel: string;
  affiliateTag: string;
  tags: MercadoLivreAffiliateTagDto[];
  lastValidatedAt: string;
  lastCookieUpdateAt: string;
  oauthStatus: string;
  lastError: string;
};

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

function SessionResult({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1 rounded-md border bg-[var(--background)] p-3">
      <dt className="text-xs text-[var(--muted-foreground)]">{label}</dt>
      <dd className="break-words text-sm font-medium">{value}</dd>
    </div>
  );
}

function sessionStatusLabel(status: string) {
  return (
    {
      NOT_CONFIGURED: "Não configurada",
      VALIDATING: "Validando",
      CONNECTED: "Conectada",
      EXPIRED: "Expirada",
      ERROR: "Erro",
    }[status] ?? status
  );
}

export function AffiliateSessionPanel({
  initialData,
}: {
  initialData: AffiliateSessionPanelInitialData;
}) {
  const [configured, setConfigured] = useState(initialData.configured);
  const [status, setStatus] = useState(initialData.status);
  const [selectedTag, setSelectedTag] = useState(initialData.affiliateTag);
  const [tags, setTags] = useState(initialData.tags);
  const [feedback, setFeedback] = useState<ActionFeedbackValue | null>(null);
  const [testLink, setTestLink] =
    useState<MercadoLivreAffiliateLinkTestDto | null>(null);
  const [batch, setBatch] = useState<MercadoLivrePendingLinksDto | null>(null);
  const [pendingOperation, setPendingOperation] = useState<string | null>(null);
  const [lastValidatedAt, setLastValidatedAt] = useState(
    initialData.lastValidatedAt,
  );
  const [lastCookieUpdateAt, setLastCookieUpdateAt] = useState(
    initialData.lastCookieUpdateAt,
  );
  const pendingRef = useRef(false);
  const [, startTransition] = useTransition();

  function start(operation: string, callback: () => Promise<void>) {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPendingOperation(operation);
    setFeedback(null);
    startTransition(async () => {
      try {
        await callback();
      } finally {
        pendingRef.current = false;
        setPendingOperation(null);
      }
    });
  }

  function applySessionResult(
    result: Awaited<
      ReturnType<typeof testMercadoLivreAffiliateSessionInteractiveAction>
    >,
    successMessage?: string,
  ) {
    if (!result.ok) {
      setFeedback({
        tone: "danger",
        message: result.message,
        errorCode: result.errorCode,
      });
      return false;
    }
    setStatus(result.data.status);
    setConfigured(result.data.status !== "NOT_CONFIGURED");
    setSelectedTag(result.data.affiliateTag ?? "");
    if (result.data.availableTags.length > 0) {
      setTags(result.data.availableTags);
    }
    setFeedback({
      tone: "success",
      message: successMessage ?? result.message,
    });
    return true;
  }

  function saveSession(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    start("save-session", async () => {
      const result =
        await saveMercadoLivreAffiliateSessionInteractiveAction(formData);
      if (applySessionResult(result, "Sessão salva e validada.")) {
        const now = new Date().toLocaleString("pt-BR");
        setLastValidatedAt(now);
        setLastCookieUpdateAt(now);
        const cookie = form.elements.namedItem(
          "cookie",
        ) as HTMLTextAreaElement | null;
        if (cookie) cookie.value = "";
      }
    });
  }

  function updateTag() {
    start("select-tag", async () => {
      const result = await selectMercadoLivreAffiliateTagInteractiveAction({
        affiliateTag: selectedTag,
      });
      applySessionResult(result, "Tag atualizada.");
    });
  }

  function testSession() {
    start("test-session", async () => {
      const result = await testMercadoLivreAffiliateSessionInteractiveAction();
      if (applySessionResult(result, "Sessão validada.")) {
        setLastValidatedAt(new Date().toLocaleString("pt-BR"));
      }
    });
  }

  function clearSession() {
    start("clear-session", async () => {
      const result = await clearMercadoLivreAffiliateSessionInteractiveAction();
      if (applySessionResult(result, "Sessão removida.")) {
        setConfigured(false);
        setTags([]);
        setSelectedTag("");
        setTestLink(null);
      }
    });
  }

  function generateTestLink(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    start("test-link", async () => {
      const result =
        await generateMercadoLivreAffiliateTestLinkInteractiveAction({
          productUrl: formData.get("productUrl"),
          affiliateTag: formData.get("affiliateTag"),
        });
      if (!result.ok) {
        setFeedback({
          tone: "danger",
          message: result.message,
          errorCode: result.errorCode,
        });
        return;
      }
      setTestLink(result.data);
      setFeedback({ tone: "success", message: result.message });
    });
  }

  function generatePending() {
    start("pending-links", async () => {
      const result =
        await generatePendingMercadoLivreAffiliateLinksInteractiveAction({
          limit: 50,
        });
      if (!result.ok) {
        setFeedback({
          tone: "danger",
          message: result.message,
          errorCode: result.errorCode,
        });
        return;
      }
      setBatch(result.data);
      setFeedback({ tone: "success", message: result.message });
    });
  }

  return (
    <Card id="links-afiliados" className="scroll-mt-24">
      <CardHeader>
        <CardTitle>Sessão de afiliado Mercado Livre</CardTitle>
        <div className="grid gap-2 text-sm text-[var(--muted-foreground)] md:grid-cols-2">
          <p className="rounded-md border bg-[var(--background)] p-3">
            <span className="font-medium text-[var(--foreground)]">OAuth:</span>{" "}
            categorias, ranking e dados dos produtos.
          </p>
          <p className="rounded-md border bg-[var(--background)] p-3">
            <span className="font-medium text-[var(--foreground)]">
              Cookie:
            </span>{" "}
            Portal de Afiliados e geração dos links meli.la.
          </p>
        </div>
      </CardHeader>
      <CardContent className="grid gap-6" aria-busy={Boolean(pendingOperation)}>
        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <SessionResult
            label="Status da sessão"
            value={
              status === initialData.status
                ? initialData.statusLabel
                : sessionStatusLabel(status)
            }
          />
          <SessionResult
            label="Cookie"
            value={configured ? "Cookie configurado" : "Não configurado"}
          />
          <SessionResult label="Tag selecionada" value={selectedTag || "-"} />
          <SessionResult
            label="Quantidade de tags encontradas"
            value={String(tags.length)}
          />
          <SessionResult label="Última validação" value={lastValidatedAt} />
          <SessionResult
            label="Última atualização do cookie"
            value={lastCookieUpdateAt}
          />
          <SessionResult
            label="Status OAuth separado"
            value={initialData.oauthStatus}
          />
          <SessionResult label="Último erro" value={initialData.lastError} />
        </dl>

        {!initialData.oauthConnected ? (
          <p className="rounded-md border bg-[var(--background)] p-3 text-sm">
            Conecte o OAuth do Mercado Livre antes de configurar a sessão de
            afiliado.
          </p>
        ) : null}

        <details className="rounded-[var(--radius-md)] border bg-[var(--background)] px-4">
          <summary className="cursor-pointer font-semibold">
            Configuração avançada da sessão
          </summary>
          <form onSubmit={saveSession} className="grid gap-4 border-t py-4">
            <div className="grid gap-4 lg:grid-cols-2">
              <Field label="Link de afiliado de referência">
                <Input
                  name="sampleAffiliateLink"
                  type="url"
                  placeholder="https://meli.la/..."
                  autoComplete="off"
                />
              </Field>
              <Field label="Tag de afiliado">
                <Select
                  name="affiliateTag"
                  value={selectedTag}
                  onChange={(event) => setSelectedTag(event.target.value)}
                >
                  <option value="">Selecionar automaticamente</option>
                  {tags.map((tag) => (
                    <option key={tag.value} value={tag.value}>
                      {tag.label}
                      {tag.isDefault ? " (padrão)" : ""}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field label="Cookie completo do Mercado Livre">
              <Textarea
                name="cookie"
                placeholder={
                  configured
                    ? "Cookie configurado. Cole aqui somente para substituir."
                    : "cookie1=valor1; cookie2=valor2"
                }
                autoComplete="off"
                spellCheck={false}
                rows={5}
              />
              <span className="text-xs text-[var(--muted-foreground)]">
                O valor salvo nunca é exibido. Deixe vazio para preservar o
                cookie atual.
              </span>
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button
                type="submit"
                disabled={!initialData.oauthConnected}
                loading={pendingOperation === "save-session"}
                loadingLabel="Salvando e testando…"
              >
                Salvar e testar
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={updateTag}
                disabled={!selectedTag}
                loading={pendingOperation === "select-tag"}
                loadingLabel="Atualizando tag…"
              >
                Atualizar tag
              </Button>
            </div>
          </form>
        </details>

        <form onSubmit={generateTestLink} className="grid gap-4 border-t pt-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <Field label="URL pública do produto para teste">
              <Input
                name="productUrl"
                type="url"
                placeholder="https://produto.mercadolivre.com.br/MLB-..."
                autoComplete="off"
                required
              />
            </Field>
            <Field label="Tag para o teste">
              <Select
                name="affiliateTag"
                value={selectedTag}
                onChange={(event) => setSelectedTag(event.target.value)}
              >
                <option value="">Usar tag selecionada</option>
                {tags.map((tag) => (
                  <option key={tag.value} value={tag.value}>
                    {tag.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Button
            type="submit"
            variant="outline"
            className="w-fit"
            disabled={status !== "CONNECTED"}
            loading={pendingOperation === "test-link"}
            loadingLabel="Gerando link de teste…"
          >
            Gerar link meli.la de teste
          </Button>
        </form>

        {testLink ? (
          <div
            className="grid gap-1 rounded-md border bg-[var(--background)] p-3 text-sm"
            aria-live="polite"
          >
            <span className="font-medium">Link gerado</span>
            <a
              href={testLink.affiliateUrl}
              target="_blank"
              rel="noreferrer"
              className="break-all underline"
            >
              {testLink.affiliateUrl}
            </a>
            <span>Modo: {testLink.provider}</span>
            <span>
              Horário: {new Date(testLink.generatedAt).toLocaleString("pt-BR")}
            </span>
          </div>
        ) : null}

        {batch ? (
          <p
            className="rounded-md border bg-[var(--background)] p-3 text-sm"
            aria-live="polite"
          >
            {batch.linksGenerated} links gerados · {batch.updated} ofertas
            atualizadas · {batch.failed} falhas
          </p>
        ) : null}

        <div className="flex flex-wrap gap-2 border-t pt-4">
          <Button
            type="button"
            variant="outline"
            onClick={testSession}
            disabled={!configured}
            loading={pendingOperation === "test-session"}
            loadingLabel="Testando conexão…"
          >
            Testar conexão
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={clearSession}
            disabled={!configured}
            loading={pendingOperation === "clear-session"}
            loadingLabel="Limpando sessão…"
          >
            Limpar sessão
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={generatePending}
            disabled={status !== "CONNECTED"}
            loading={pendingOperation === "pending-links"}
            loadingLabel="Gerando links pendentes…"
          >
            Gerar links pendentes
          </Button>
        </div>
        <ActionFeedback value={feedback} focusOnError />
      </CardContent>
    </Card>
  );
}
