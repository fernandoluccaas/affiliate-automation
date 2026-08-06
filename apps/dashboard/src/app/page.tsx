import {
  Activity,
  AlertTriangle,
  Boxes,
  CalendarClock,
  MousePointerClick,
} from "lucide-react";
import { AdminShell } from "@/components/admin-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert } from "@/components/ui/alert";
import { MetricCard, MetricGrid } from "@/components/ui/page";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { getDashboardMetrics } from "@/lib/dashboard-metrics";
import { DashboardChart } from "./dashboard-chart";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const dashboardMetrics = await getDashboardMetrics();
  const metrics = [
    {
      label: "Ofertas prontas",
      value: dashboardMetrics.readyOffers,
      icon: Boxes,
      detail: "Disponíveis para planejamento",
    },
    {
      label: "Publicações hoje",
      value: dashboardMetrics.publicationsToday,
      icon: CalendarClock,
      detail: "Confirmadas no período",
    },
    {
      label: "Cliques hoje",
      value: dashboardMetrics.clicksToday,
      icon: MousePointerClick,
      detail: "Eventos persistidos",
    },
    {
      label: "Alertas abertos",
      value: dashboardMetrics.openAlerts,
      icon: AlertTriangle,
      detail: "Pendências operacionais",
      tone:
        dashboardMetrics.openAlerts > 0
          ? ("warning" as const)
          : ("success" as const),
    },
  ];

  return (
    <AdminShell
      currentPath="/"
      title="Dashboard operacional"
      actions={
        <Button asChild variant="outline">
          <Link href="/ofertas">Revisar ofertas</Link>
        </Button>
      }
    >
      {dashboardMetrics.openAlerts > 0 ? (
        <Alert tone="warning" title="Há pendências operacionais">
          {dashboardMetrics.openAlerts} alerta
          {dashboardMetrics.openAlerts === 1 ? " precisa" : "s precisam"} de
          revisão.{" "}
          <Link className="font-semibold underline" href="/logs">
            Abrir alertas
          </Link>
          .
        </Alert>
      ) : (
        <Alert tone="success" title="Nenhum alerta aberto">
          O painel não encontrou pendências operacionais que exijam atenção
          agora.
        </Alert>
      )}

      <MetricGrid>
        {metrics.map((metric) => (
          <MetricCard key={metric.label} {...metric} />
        ))}
      </MetricGrid>

      <div className="grid gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Activity aria-hidden="true" size={18} />
              Cliques por dia
            </CardTitle>
            <p className="text-sm text-[var(--foreground-secondary)]">
              Últimos sete dias, sem estimativas.
            </p>
          </CardHeader>
          <CardContent>
            <DashboardChart data={dashboardMetrics.clickSeries} />
          </CardContent>
        </Card>
      </div>
    </AdminShell>
  );
}
