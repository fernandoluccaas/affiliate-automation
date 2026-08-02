import {
  Activity,
  Boxes,
  CalendarClock,
  Cog,
  Gift,
  Link2,
  Megaphone,
  PackageSearch,
  RadioTower,
  ScrollText,
  ClipboardCheck,
} from "lucide-react";

export const adminNavigation = [
  { label: "Dashboard", href: "/", icon: Activity },
  { label: "Ofertas", href: "/ofertas", icon: Boxes },
  { label: "Produtos", href: "/produtos", icon: PackageSearch },
  { label: "Cupons", href: "/cupons", icon: Gift },
  { label: "Canais", href: "/canais", icon: Megaphone },
  { label: "Integracoes", href: "/integracoes", icon: Link2 },
  { label: "Publicacoes", href: "/publicacoes", icon: CalendarClock },
  { label: "Fila assistida", href: "/publicacoes-assistidas", icon: ClipboardCheck },
  { label: "Automacoes", href: "/automacoes", icon: RadioTower },
  { label: "Configuracoes", href: "/configuracoes", icon: Cog },
  { label: "Logs", href: "/logs", icon: ScrollText },
] as const;

export const visibleAdminNavigation = adminNavigation;
