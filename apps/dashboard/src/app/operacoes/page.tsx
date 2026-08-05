import {
  collectOperationalStatus,
  collectStateAudit,
  readBurnInReport,
} from "@affiliate/operations";
import { AdminShell } from "@/components/admin-shell";
import { formatDateTime } from "@/lib/format";

export const dynamic = "force-dynamic";

function StatusCard(props: { title: string; value: string; detail?: string }) {
  return (
    <div className="rounded-md border bg-white p-4">
      <h2 className="text-sm text-[var(--muted-foreground)]">{props.title}</h2>
      <p className="mt-2 text-xl font-semibold">{props.value}</p>
      {props.detail ? <p className="mt-1 text-xs">{props.detail}</p> : null}
    </div>
  );
}

export default async function OperationsPage() {
  const status = await collectOperationalStatus();
  const findings = status.database === "OK" ? await collectStateAudit() : [];
  const burnInReport = await readBurnInReport();
  const critical = findings.filter(
    (finding) =>
      finding.severity === "CRITICAL" ||
      finding.severity === "HUMAN_REVIEW_REQUIRED",
  );

  return (
    <AdminShell currentPath="/operacoes" title="Operações locais">
      <p className="rounded-md border border-blue-200 bg-blue-50 p-3 text-sm">
        Painel somente leitura. Processos, backups, tarefas e dispatch continuam
        disponíveis exclusivamente no terminal local.
      </p>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatusCard title="Aplicação" value={status.status} />
        <StatusCard
          title="Supervisor"
          value={status.supervisor.state}
          detail={`${status.workerContext.expectation} / ${status.supervisor.uptimeSeconds}s`}
        />
        <StatusCard title="PostgreSQL" value={status.database} />
        <StatusCard title="Redis" value={status.redis} />
        <StatusCard
          title="Worker"
          value={status.worker.state}
          detail={`heartbeat ${formatDateTime(status.worker.lastHeartbeatAt)}`}
        />
        <StatusCard
          title="Modo"
          value={status.worker.mode}
          detail={status.worker.burnInActive ? "burn-in ativo" : "operação normal"}
        />
        <StatusCard
          title="Liderança"
          value={status.worker.leaderStatus ?? "AUSENTE"}
          detail={`instance ${status.worker.instanceId ?? "-"}`}
        />
        <StatusCard
          title="Último ciclo"
          value={status.worker.lastCycleStatus ?? "AUSENTE"}
          detail={formatDateTime(status.worker.lastCycleFinishedAt)}
        />
        <StatusCard
          title="Ciclos bloqueados"
          value={String(status.worker.blockedCycles)}
          detail={`efeitos externos ${status.worker.externalEffectsObserved} / alterações de negócio ${status.worker.businessChangesObserved}`}
        />
        <StatusCard
          title="Último burn-in"
          value={burnInReport?.status ?? "AUSENTE"}
          detail={burnInReport ? `${burnInReport.durationSeconds}s / locks ${burnInReport.residualLocks}` : "execute no terminal local"}
        />
        <StatusCard
          title="Última automação"
          value={status.lastAutomationRun?.status ?? "AUSENTE"}
          detail={formatDateTime(status.lastAutomationRun?.startedAt ?? null)}
        />
        <StatusCard
          title="Backup"
          value={status.backup?.verified ? "VERIFICADO" : "AUSENTE"}
          detail={
            status.backup
              ? `${status.backup.ageHours}h / ${status.backup.sizeBytes} bytes`
              : "execute ops:backup-db no terminal"
          }
        />
        <StatusCard
          title="Alertas humanos"
          value={String(critical.length)}
          detail="nenhuma ação automática é executada"
        />
      </section>

      <section className="rounded-md border bg-white p-4">
        <h2 className="font-semibold">Processos supervisionados</h2>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {status.components.map((component) => (
            <div key={component.component} className="rounded border p-3 text-sm">
              <strong>{component.component}</strong>: {component.status}
              <div className="mt-1 text-xs">
                restarts {component.restartCount} / crashes consecutivos {component.consecutiveCrashes}
              </div>
              {component.action ? (
                <div className="mt-1 text-xs text-red-700">{component.action}</div>
              ) : null}
            </div>
          ))}
          {status.components.length === 0 ? (
            <p className="text-sm">Nenhum processo registrado.</p>
          ) : null}
        </div>
      </section>

      <section className="rounded-md border bg-white p-4">
        <h2 className="font-semibold">Filas WhatsApp Web</h2>
        <p className="mt-1 text-xs text-[var(--muted-foreground)]">
          Role horizontalmente quando necessário; os estados não são alterados por
          esta página.
        </p>
        <div className="mt-3 overflow-x-auto" tabIndex={0} aria-label="Filas WhatsApp com rolagem horizontal">
          <table className="min-w-[760px] w-full text-left text-sm">
            <thead className="border-b bg-[var(--muted)]">
              <tr>
                <th className="px-3 py-2">Canal</th>
                <th className="px-3 py-2">Ativa</th>
                <th className="px-3 py-2">Itens</th>
                <th className="px-3 py-2">Entrega incerta</th>
                <th className="sticky right-0 bg-[var(--muted)] px-3 py-2">Pausado</th>
              </tr>
            </thead>
            <tbody>
              {status.whatsappQueues.map((queue) => (
                <tr key={queue.channelId} className="border-b">
                  <td className="px-3 py-2 font-mono text-xs">{queue.channelId.slice(0, 12)}</td>
                  <td className="px-3 py-2">{queue.activeState ?? "-"}</td>
                  <td className="px-3 py-2">{queue.total}</td>
                  <td className="px-3 py-2">{queue.deliveryUncertain}</td>
                  <td className="sticky right-0 bg-white px-3 py-2">{String(queue.paused)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-md border bg-white p-4">
        <h2 className="font-semibold">Auditoria de estado</h2>
        {findings.length === 0 ? (
          <p className="mt-2 text-sm">Nenhum achado operacional.</p>
        ) : (
          <ul className="mt-3 grid gap-2 text-sm">
            {findings.map((finding, index) => (
              <li key={`${finding.code}-${index}`} className="rounded border p-3">
                <strong>{finding.severity}</strong> — {finding.code}
                <div className="mt-1 text-xs">Ação: {finding.action}</div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-md border bg-white p-4">
        <h2 className="font-semibold">Comandos locais somente leitura</h2>
        <div className="mt-3 grid gap-2">
          {["npm run ops:preflight", "npm run ops:status", "npm run ops:audit-state", "npm run ops:backup-status", "npm run ops:burn-in:status", "npm run ops:burn-in:report"].map(
            (command) => (
              <code key={command} className="select-all rounded bg-slate-950 p-2 text-xs text-white">
                {command}
              </code>
            ),
          )}
        </div>
      </section>
    </AdminShell>
  );
}
