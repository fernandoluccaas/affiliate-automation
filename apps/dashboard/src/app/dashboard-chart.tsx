"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, XAxis, YAxis } from "recharts";

const emptySeries = [
  { day: "Seg", clicks: 0 },
  { day: "Ter", clicks: 0 },
  { day: "Qua", clicks: 0 },
  { day: "Qui", clicks: 0 },
  { day: "Sex", clicks: 0 },
  { day: "Sab", clicks: 0 },
  { day: "Dom", clicks: 0 },
];

export function DashboardChart() {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={emptySeries}>
        <CartesianGrid strokeDasharray="3 3" stroke="#d8d8d0" />
        <XAxis dataKey="day" />
        <YAxis allowDecimals={false} />
        <Bar dataKey="clicks" fill="#155e75" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
