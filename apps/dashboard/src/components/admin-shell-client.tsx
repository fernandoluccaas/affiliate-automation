"use client";

import {
  ChevronDown,
  ChevronRight,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  X,
} from "lucide-react";
import Link from "next/link";
import React, { useEffect, useId, useRef, useState } from "react";
import { navigationGroups, isNavigationItemActive } from "@/lib/navigation";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";

type AdminShellClientProps = {
  currentPath: string;
  title: string;
  description?: string;
  actions?: React.ReactNode;
  userEmail: string;
  logout: React.ReactNode;
  children: React.ReactNode;
};

const pageDescriptions: Record<string, string> = {
  "/": "Acompanhe o desempenho e as pendências que exigem atenção.",
  "/resultados":
    "Analise tracking, conversões e comissões sem misturar moedas.",
  "/produtos": "Consulte os produtos consolidados das integrações.",
  "/ofertas":
    "Revise preços, score, links afiliados e prontidão para publicação.",
  "/cupons": "Acompanhe cupons associados às ofertas do catálogo.",
  "/publicacoes": "Acompanhe planejamento, tentativas e estados de entrega.",
  "/publicacoes-assistidas":
    "Opere a fila assistida dos grupos WhatsApp com confirmação humana.",
  "/canais": "Configure limites, horários e políticas por canal.",
  "/automacoes":
    "Monitore o worker e controle pausas de descoberta e publicação.",
  "/integracoes": "Gerencie conexões oficiais e o estado de cada provedor.",
  "/operacoes":
    "Consulte saúde, supervisor, filas e auditoria do ambiente local.",
  "/logs": "Investigue alertas operacionais com filtros e contexto.",
  "/configuracoes":
    "Consulte como as configurações sensíveis são administradas.",
};

function descriptionForPath(path: string) {
  if (path.startsWith("/integracoes/mercado-livre")) {
    return "Configure a integração oficial, a descoberta e os links afiliados.";
  }
  if (path.startsWith("/ofertas/affiliate-links")) {
    return "Aplique links oficiais preservando validação, score e versionamento.";
  }
  if (path.startsWith("/ofertas/nova"))
    return "Cadastre uma oferta manual no pipeline existente.";
  return pageDescriptions[path];
}

function breadcrumbsForPath(path: string, title: string) {
  if (path.startsWith("/integracoes/mercado-livre")) {
    return [
      { label: "Integrações", href: "/integracoes" },
      { label: "Mercado Livre" },
    ];
  }
  if (path.startsWith("/ofertas/affiliate-links")) {
    return [
      { label: "Ofertas", href: "/ofertas" },
      { label: "Links de afiliado" },
    ];
  }
  if (path.startsWith("/ofertas/nova")) {
    return [{ label: "Ofertas", href: "/ofertas" }, { label: "Nova oferta" }];
  }
  return [{ label: title }];
}

function Brand({ collapsed = false }: { collapsed?: boolean }) {
  return (
    <Link
      href="/"
      className="flex min-h-11 items-center gap-3 rounded-lg px-2 text-[var(--sidebar-foreground)] focus-visible:outline-offset-2"
      aria-label="Affiliate Automation — Dashboard"
    >
      <span
        className="grid size-8 shrink-0 place-items-center rounded-lg bg-[var(--primary)] text-sm font-bold text-[var(--primary-foreground)]"
        aria-hidden="true"
      >
        AA
      </span>
      {!collapsed ? (
        <span className="truncate text-sm font-semibold">
          Affiliate Automation
        </span>
      ) : null}
    </Link>
  );
}

function Navigation({
  currentPath,
  collapsed = false,
  onNavigate,
}: {
  currentPath: string;
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  return (
    <nav aria-label="Navegação principal" className="grid gap-5">
      {navigationGroups.map((group) => {
        const groupActive = group.items.some((item) =>
          isNavigationItemActive(currentPath, item.href),
        );
        return (
          <div key={group.label} className="grid gap-1">
            {!collapsed ? (
              <p
                className={cn(
                  "px-3 pb-1 text-[0.6875rem] font-semibold uppercase tracking-[0.12em] text-[var(--sidebar-muted)]",
                  groupActive && "text-[var(--sidebar-foreground)]",
                )}
              >
                {group.label}
              </p>
            ) : null}
            {group.items.map((item) => {
              const active = isNavigationItemActive(currentPath, item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  {...(onNavigate ? { onClick: onNavigate } : {})}
                  title={collapsed ? item.label : undefined}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "group relative flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium text-[var(--sidebar-muted)] transition-colors hover:bg-white/8 hover:text-[var(--sidebar-foreground)]",
                    active &&
                      "bg-white/12 text-[var(--sidebar-foreground)] before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-[var(--primary)]",
                    collapsed && "justify-center px-2",
                  )}
                >
                  <item.icon
                    aria-hidden="true"
                    size={18}
                    className="shrink-0"
                  />
                  {!collapsed ? (
                    <span>{item.label}</span>
                  ) : (
                    <span className="sr-only">{item.label}</span>
                  )}
                </Link>
              );
            })}
          </div>
        );
      })}
    </nav>
  );
}

function MobileNavigation({ currentPath }: { currentPath: string }) {
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panelRef.current?.querySelector<HTMLElement>("a,button")?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;
      const focusable = [
        ...panelRef.current.querySelectorAll<HTMLElement>(
          'a[href],button:not([disabled]),[tabindex]:not([tabindex="-1"])',
        ),
      ];
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
      triggerRef.current?.focus();
    };
  }, [open]);

  return (
    <>
      <Button
        ref={triggerRef}
        type="button"
        variant="ghost"
        size="icon"
        className="lg:hidden"
        aria-label="Abrir menu principal"
        aria-expanded={open}
        aria-controls="mobile-navigation"
        onClick={() => setOpen(true)}
      >
        <Menu aria-hidden="true" size={20} />
      </Button>
      {open ? (
        <div className="fixed inset-0 z-50 lg:hidden" role="presentation">
          <button
            className="absolute inset-0 bg-[var(--overlay)]"
            type="button"
            aria-label="Fechar menu principal"
            onClick={() => setOpen(false)}
          />
          <div
            id="mobile-navigation"
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className="absolute inset-y-0 left-0 flex w-[min(88vw,20rem)] flex-col bg-[var(--sidebar)] p-4 shadow-[var(--shadow-md)]"
          >
            <div className="flex items-center justify-between gap-3 border-b border-white/12 pb-4">
              <span id={titleId} className="sr-only">
                Menu principal
              </span>
              <Brand />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="text-[var(--sidebar-foreground)] hover:bg-white/10"
                aria-label="Fechar menu principal"
                onClick={() => setOpen(false)}
              >
                <X aria-hidden="true" size={20} />
              </Button>
            </div>
            <div className="mt-5 flex-1 overflow-y-auto pr-1">
              <Navigation
                currentPath={currentPath}
                onNavigate={() => setOpen(false)}
              />
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

export function AdminShellClient({
  currentPath,
  title,
  description,
  actions,
  userEmail,
  logout,
  children,
}: AdminShellClientProps) {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    setCollapsed(
      localStorage.getItem("affiliate-sidebar-collapsed") === "true",
    );
  }, []);

  function toggleCollapsed() {
    setCollapsed((value) => {
      localStorage.setItem("affiliate-sidebar-collapsed", String(!value));
      return !value;
    });
  }

  const breadcrumbs = breadcrumbsForPath(currentPath, title);

  return (
    <div className="min-h-screen bg-[var(--background)]">
      <a
        href="#main-content"
        className="fixed left-3 top-3 z-[70] -translate-y-20 rounded-md bg-[var(--primary)] px-4 py-2 font-medium text-[var(--primary-foreground)] focus:translate-y-0"
      >
        Ir para o conteúdo
      </a>

      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 hidden flex-col bg-[var(--sidebar)] px-3 py-4 transition-[width] lg:flex",
          collapsed ? "w-[5rem]" : "w-[16.5rem]",
        )}
      >
        <Brand collapsed={collapsed} />
        <div className="mt-7 flex-1 overflow-y-auto overflow-x-hidden">
          <Navigation currentPath={currentPath} collapsed={collapsed} />
        </div>
        <button
          type="button"
          onClick={toggleCollapsed}
          className="mt-4 flex min-h-11 items-center justify-center gap-2 rounded-lg border border-white/12 px-3 text-sm text-[var(--sidebar-muted)] hover:bg-white/8 hover:text-[var(--sidebar-foreground)]"
          aria-label={
            collapsed ? "Expandir barra lateral" : "Recolher barra lateral"
          }
          title={collapsed ? "Expandir barra lateral" : undefined}
        >
          {collapsed ? (
            <PanelLeftOpen aria-hidden="true" size={18} />
          ) : (
            <PanelLeftClose aria-hidden="true" size={18} />
          )}
          {!collapsed ? <span>Recolher</span> : null}
        </button>
      </aside>

      <div
        className={cn(
          "min-w-0 transition-[padding]",
          collapsed ? "lg:pl-[5rem]" : "lg:pl-[16.5rem]",
        )}
      >
        <header className="sticky top-0 z-30 border-b bg-[color-mix(in_srgb,var(--surface)_94%,transparent)] backdrop-blur">
          <div className="flex min-h-16 items-center gap-2 px-[var(--space-page)]">
            <MobileNavigation currentPath={currentPath} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold lg:hidden">
                {title}
              </p>
              <p className="hidden text-xs text-[var(--muted-foreground)] lg:block">
                Console administrativo
              </p>
            </div>
            <ThemeToggle />
            <details className="relative">
              <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-lg px-2 text-sm hover:bg-[var(--muted)] [&::-webkit-details-marker]:hidden">
                <span
                  className="grid size-8 place-items-center rounded-full bg-[var(--primary-subtle)] font-semibold text-[var(--primary)]"
                  aria-hidden="true"
                >
                  {userEmail.slice(0, 1).toUpperCase()}
                </span>
                <span className="hidden max-w-44 truncate sm:block">
                  {userEmail}
                </span>
                <ChevronDown aria-hidden="true" size={15} />
              </summary>
              <div className="absolute right-0 mt-2 w-64 rounded-lg border bg-[var(--surface-elevated)] p-2 shadow-[var(--shadow-md)]">
                <p className="truncate border-b px-2 pb-2 text-xs text-[var(--muted-foreground)]">
                  {userEmail}
                </p>
                <div className="mt-1">{logout}</div>
              </div>
            </details>
          </div>
        </header>

        <main
          id="main-content"
          className="mx-auto grid max-w-[var(--content-wide)] gap-6 px-[var(--space-page)] py-6 sm:py-8"
        >
          <header className="grid gap-4 border-b pb-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
            <div className="min-w-0">
              <nav aria-label="Breadcrumb" className="mb-2">
                <ol className="flex min-w-0 flex-wrap items-center gap-1 text-xs text-[var(--muted-foreground)]">
                  {breadcrumbs.map((item, index) => (
                    <li
                      key={`${item.label}-${index}`}
                      className="flex min-w-0 items-center gap-1"
                    >
                      {index > 0 ? (
                        <ChevronRight aria-hidden="true" size={13} />
                      ) : null}
                      {item.href ? (
                        <Link
                          href={item.href}
                          className="rounded hover:text-[var(--foreground)] hover:underline"
                        >
                          {item.label}
                        </Link>
                      ) : (
                        <span aria-current="page" className="truncate">
                          {item.label}
                        </span>
                      )}
                    </li>
                  ))}
                </ol>
              </nav>
              <h1 className="text-2xl font-semibold tracking-[-0.02em] sm:text-3xl">
                {title}
              </h1>
              <p className="mt-2 max-w-3xl text-sm text-[var(--foreground-secondary)] sm:text-base">
                {description ?? descriptionForPath(currentPath)}
              </p>
            </div>
            {actions ? (
              <div className="flex flex-wrap items-center gap-2">{actions}</div>
            ) : null}
          </header>
          {children}
        </main>
      </div>
    </div>
  );
}
