"use client";

import { Laptop, Moon, Sun } from "lucide-react";
import React, { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

export type ThemePreference = "system" | "light" | "dark";

const themes: Array<{
  value: ThemePreference;
  label: string;
  icon: typeof Laptop;
}> = [
  { value: "system", label: "Seguir o sistema", icon: Laptop },
  { value: "light", label: "Tema claro", icon: Sun },
  { value: "dark", label: "Tema escuro", icon: Moon },
];

export function applyTheme(theme: ThemePreference) {
  if (theme === "system")
    document.documentElement.removeAttribute("data-theme");
  else document.documentElement.dataset.theme = theme;
  localStorage.setItem("affiliate-theme", theme);
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<ThemePreference>("system");

  useEffect(() => {
    const saved = localStorage.getItem("affiliate-theme");
    if (saved === "light" || saved === "dark" || saved === "system")
      setTheme(saved);
  }, []);

  const currentIndex = themes.findIndex((item) => item.value === theme);
  const current = themes[currentIndex] ?? themes[0]!;
  const Icon = current.icon;

  function cycleTheme() {
    const next = themes[(currentIndex + 1) % themes.length] ?? themes[0]!;
    setTheme(next.value);
    applyTheme(next.value);
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={cycleTheme}
      aria-label={`${current.label}. Alterar tema`}
      title={`${current.label}. Alterar tema`}
    >
      <Icon aria-hidden="true" size={18} />
    </Button>
  );
}
