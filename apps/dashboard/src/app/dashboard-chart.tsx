"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, XAxis, YAxis } from "recharts";
import type { ClickSeriesPoint } from "@/lib/dashboard-metrics";

type DashboardChartProps = {
  data: ClickSeriesPoint[];
};

export function DashboardChart({ data }: DashboardChartProps) {
  const hasClicks = data.some((point) => point.clicks > 0);

  if (!hasClicks) {
    return (
      <div className="flex h-[220px] items-center justify-center rounded-md border border-dashed bg-[var(--background)] px-4 text-center text-sm text-[var(--muted-foreground)]">
        Nenhum clique registrado nos ultimos sete dias.
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke="#d8d8d0" />
        <XAxis dataKey="day" />
        <YAxis allowDecimals={false} />
        <Bar dataKey="clicks" fill="#155e75" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
