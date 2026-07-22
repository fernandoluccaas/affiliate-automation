import { Activity, AlertTriangle, Boxes, CalendarClock, LogOut, MousePointerClick } from "lucide-react";
import { logoutAction } from "@/lib/actions";
import { requireSession } from "@/lib/session";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DashboardChart } from "./dashboard-chart";

export const dynamic = "force-dynamic";

const metrics = [
  { label: "Ofertas prontas", value: 0, icon: Boxes },
  { label: "Publicacoes hoje", value: 0, icon: CalendarClock },
  { label: "Cliques hoje", value: 0, icon: MousePointerClick },
  { label: "Alertas abertos", value: 0, icon: AlertTriangle },
];

const pages = [
  "Ofertas",
  "Produtos",
  "Cupons",
  "Calendario",
  "Canais",
  "Publicacoes",
  "Cliques",
  "Conversoes",
  "Comissoes",
  "Automacoes",
  "Integracoes",
  "Configuracoes",
  "Logs e alertas",
];

export default async function DashboardPage() {
  const user = await requireSession();

  return (
    <main className="min-h-screen">
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <div>
            <h1 className="text-xl font-semibold">Affiliate Automation</h1>
            <p className="text-sm text-[var(--muted-foreground)]">{user.email}</p>
          </div>
          <form action={logoutAction}>
            <Button variant="outline" type="submit">
              <LogOut aria-hidden="true" size={18} />
              Sair
            </Button>
          </form>
        </div>
      </header>

      <section className="mx-auto grid max-w-7xl gap-6 px-6 py-6">
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

        <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Activity aria-hidden="true" size={18} />
                Cliques por dia
              </CardTitle>
            </CardHeader>
            <CardContent>
              <DashboardChart />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Areas administrativas</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-2">
                {pages.map((page) => (
                  <div
                    key={page}
                    className="rounded-md border bg-[var(--background)] px-3 py-2 text-sm"
                  >
                    {page}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </section>
    </main>
  );
}
