import { Activity, AlertTriangle, Boxes, CalendarClock, MousePointerClick } from "lucide-react";
import { AdminShell } from "@/components/admin-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getDashboardMetrics } from "@/lib/dashboard-metrics";
import { DashboardChart } from "./dashboard-chart";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const dashboardMetrics = await getDashboardMetrics();
  const metrics = [
    { label: "Ofertas prontas", value: dashboardMetrics.readyOffers, icon: Boxes },
    { label: "Publicacoes hoje", value: dashboardMetrics.publicationsToday, icon: CalendarClock },
    { label: "Cliques hoje", value: dashboardMetrics.clicksToday, icon: MousePointerClick },
    { label: "Alertas abertos", value: dashboardMetrics.openAlerts, icon: AlertTriangle },
  ];

  return (
    <AdminShell currentPath="/" title="Dashboard operacional">
        <div className="grid gap-4 md:grid-cols-4">
          {metrics.map((metric) => (
            <Card key={metric.label}>
              <CardHeader className="flex-row items-center justify-between space-y-0">
                <CardTitle className="text-sm font-medium">{metric.label}</CardTitle>
                <metric.icon aria-hidden="true" className="text-[var(--primary)]" size={18} />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-semibold">{metric.value}</div>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="grid gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Activity aria-hidden="true" size={18} />
                Cliques por dia
              </CardTitle>
            </CardHeader>
            <CardContent>
              <DashboardChart data={dashboardMetrics.clickSeries} />
            </CardContent>
          </Card>
        </div>
    </AdminShell>
  );
}
