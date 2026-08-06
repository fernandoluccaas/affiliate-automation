"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ClickSeriesPoint } from "@/lib/dashboard-metrics";

type DashboardChartProps = {
  data: ClickSeriesPoint[];
};

export function DashboardChart({ data }: DashboardChartProps) {
  const hasClicks = data.some((point) => point.clicks > 0);

  if (!hasClicks) {
    return (
      <div
        role="status"
        className="flex h-[240px] items-center justify-center rounded-md border border-dashed bg-[var(--background)] px-4 text-center text-sm text-[var(--muted-foreground)]"
      >
        Nenhum clique foi registrado nos últimos sete dias. Os dados aparecerão
        aqui quando o tracking receber eventos.
      </div>
    );
  }

  return (
    <div
      role="img"
      aria-label="Gráfico de cliques registrados por dia nos últimos sete dias"
    >
      <ResponsiveContainer width="100%" height={240}>
        <BarChart data={data} accessibilityLayer>
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="var(--border)"
            vertical={false}
          />
          <XAxis dataKey="day" tickLine={false} axisLine={false} />
          <YAxis
            allowDecimals={false}
            tickLine={false}
            axisLine={false}
            width={32}
          />
          <Tooltip
            cursor={{ fill: "var(--muted)" }}
            contentStyle={{
              background: "var(--surface-elevated)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-md)",
              color: "var(--foreground)",
            }}
          />
          <Bar
            name="Cliques"
            dataKey="clicks"
            fill="var(--chart-1)"
            radius={[5, 5, 0, 0]}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
