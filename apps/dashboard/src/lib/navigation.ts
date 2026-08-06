import {
  Activity,
  BarChart3,
  Boxes,
  CalendarClock,
  ClipboardCheck,
  Cog,
  Gift,
  Link2,
  Megaphone,
  PackageSearch,
  RadioTower,
  ScrollText,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";

export type NavigationItem = { label: string; href: string; icon: LucideIcon };
export type NavigationGroup = { label: string; items: NavigationItem[] };

export const navigationGroups: NavigationGroup[] = [
  {
    label: "Visão geral",
    items: [
      { label: "Dashboard", href: "/", icon: Activity },
      { label: "Resultados", href: "/resultados", icon: BarChart3 },
    ],
  },
  {
    label: "Catálogo",
    items: [
      { label: "Produtos", href: "/produtos", icon: PackageSearch },
      { label: "Ofertas", href: "/ofertas", icon: Boxes },
      { label: "Cupons", href: "/cupons", icon: Gift },
    ],
  },
  {
    label: "Distribuição",
    items: [
      { label: "Publicações", href: "/publicacoes", icon: CalendarClock },
      {
        label: "Fila WhatsApp",
        href: "/publicacoes-assistidas",
        icon: ClipboardCheck,
      },
      { label: "Canais", href: "/canais", icon: Megaphone },
      { label: "Automações", href: "/automacoes", icon: RadioTower },
    ],
  },
  {
    label: "Integrações",
    items: [{ label: "Integrações", href: "/integracoes", icon: Link2 }],
  },
  {
    label: "Sistema",
    items: [
      { label: "Operações", href: "/operacoes", icon: ShieldCheck },
      { label: "Logs", href: "/logs", icon: ScrollText },
      { label: "Configurações", href: "/configuracoes", icon: Cog },
    ],
  },
];

export const adminNavigation = navigationGroups.flatMap((group) => group.items);
export const visibleAdminNavigation = adminNavigation;

export function isNavigationItemActive(currentPath: string, href: string) {
  return (
    currentPath === href || (href !== "/" && currentPath.startsWith(`${href}/`))
  );
}

export function navigationLabelForPath(path: string) {
  return adminNavigation.find((item) => isNavigationItemActive(path, item.href))
    ?.label;
}
