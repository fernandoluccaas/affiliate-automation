# Phase 5G - Operational Reliability and Safe Burn-In

## Purpose and safety boundary

Burn-in proves the local Windows process lifecycle without running affiliate business
jobs. It starts the real dashboard and a dedicated real worker entrypoint, connects to
PostgreSQL and Redis, acquires and renews worker leadership, writes the existing
sanitized heartbeat, exercises timers, and shuts down cooperatively.

The burn-in worker does not import the normal worker entrypoint. Its import graph is
limited to the database package, Redis lock package, continuous runtime and leadership
module. Discovery, Mercado Livre, Telegram, publishers, AI providers, WhatsApp and
Playwright are not constructed or invoked.

The only database mutation allowed is the existing `worker:continuous:status`
heartbeat. Business snapshots explicitly exclude that `SystemSetting`.

## Normal mode versus burn-in

| Mode | Worker entrypoint | Business jobs | Leadership key |
| --- | --- | --- | --- |
| `NORMAL` | `src/index.ts` | Enabled according to normal controls | `affiliate:worker:leader` |
| `BURN_IN` | `src/burn-in-entry.ts` | Structurally blocked | Real key for an operator-started burn-in; isolated random test key for smoke |

Setting `WORKER_BURN_IN_MODE=true` does not silently convert the normal worker. The
normal entrypoint and normal supervisor refuse to start in that ambiguous state. The
operator must use an explicit burn-in command.

## Required configuration

The following values are exact and fail closed. Missing, empty, differently cased or
false values are rejected:

```text
WHATSAPP_WEB_DRY_RUN=true
WORKER_REQUIRE_REDIS=true
WORKER_BURN_IN_MODE=true
```

`WORKER_BURN_IN_MODE` should normally remain `false` in `.env`. Enable it only in the
current PowerShell process for an explicitly requested burn-in; commands never rewrite
`.env`:

```powershell
$env:WORKER_BURN_IN_MODE = "true"
```

The supervisor stability reset defaults to ten minutes:

```text
AFFILIATE_SUPERVISOR_STABLE_RESET_SECONDS=600
```

After this healthy interval, only that component's `consecutiveCrashes` and backoff
are reset. The process is not restarted and the other component is untouched.

## Preflight and bounded smoke

PostgreSQL and Redis must be healthy, all migrations applied, the production dashboard
built, the common supervisor intentionally stopped, no scheduled Affiliate Automation
task active, and the exact safety variables configured.

```powershell
$env:WORKER_BURN_IN_MODE = "true"
npm run ops:burn-in:preflight
npm run ops:burn-in:smoke -- --duration-seconds 60
npm run ops:burn-in:status
npm run ops:burn-in:report
Remove-Item Env:WORKER_BURN_IN_MODE
```

The smoke stops automatically. It uses an isolated key matching
`affiliate:test:worker:leader:<random-id>`, verifies its removal, and compares a
read-only fingerprint of the real leadership key before and after. Failure to release
the test key prevents a successful report.

The report is derived from actual component/leadership events, sampled heartbeats,
live/ready HTTP responses, process state, Redis ownership probes and sanitized database
snapshots. It never contains lock tokens, connection URLs, cookies, messages, group
names, browser profile paths or environment values.

Smoke reports are always marked `reportSource: SMOKE`. They are stored as the last
completed report, but are never presented as evidence for a concurrently running
manual session.

## Explicit continuous burn-in

Starting requires an exact confirmation flag:

```powershell
$env:WORKER_BURN_IN_MODE = "true"
npm run ops:burn-in:preflight
npm run ops:burn-in:start -- --confirm-burn-in
npm run ops:burn-in:status
```

Start creates `.local/ops/burn-in-session.json` atomically before the supervisor is
launched. The session contains a random identifier, start timestamp, sanitized
business baseline, initial findings and the real leadership-key fingerprint. Events
from the supervisor, process hosts and worker carry that exact session identifier.
An active, incomplete or corrupt session blocks another start and requires review;
there is no command that discards incomplete evidence.

While the session is active, the supervisor performs a bounded read-only observation
of `/api/health/live`, `/api/health/ready` and the sanitized heartbeat. It does not run
jobs and stops with the supervisor. `ops:burn-in:status` reports `currentSession`
separately from `lastCompletedReport`, including the current elapsed time.

Without `--confirm-burn-in`, no supervisor, dashboard, worker, PID, file lock,
leadership lock or heartbeat is created.

Stop and inspect:

```powershell
npm run ops:burn-in:stop
npm run ops:burn-in:status
npm run ops:burn-in:report
Remove-Item Env:WORKER_BURN_IN_MODE
```

Stop is cooperative and idempotent. It captures the final snapshot and findings,
filters evidence by the current `sessionId`, validates process and leadership release,
writes the report through a temporary file and atomic rename, archives it below
`.local/ops/burn-in-reports`, then marks the session completed. A second stop preserves
the completed report. Missing final evidence, residual processes/locks or an unproven
leadership release produces `HUMAN_REVIEW_REQUIRED`. After a proven release, the
public worker leadership state is `RELEASED`; an unproven release is
`RELEASE_FAILED`.

The automated manual-path smoke exercises start, observation, status, stop and report
with the same lifecycle and an isolated Redis key:

```powershell
npm run ops:burn-in:manual-smoke -- --duration-seconds 60
```

Its report is marked `reportSource: MANUAL_TEST`; a real operator-started session is
marked `reportSource: MANUAL`.

Do not use Task Scheduler for the first burn-in and do not configure automatic boot
until the owner has accepted a manual run.

## Thirty-minute and 24-hour procedures

For a 30-minute run, start explicitly, observe `ops:burn-in:status` and `/operacoes`,
record the start time, and issue `ops:burn-in:stop` after 30 minutes. For a 24-hour run,
follow the same manual procedure, checking status periodically. Neither run is started
by installation, build, tests, Prisma, dashboard startup or the task scheduler.

Before either long run, complete and accept the 60-second smoke. Keep a verified
database backup, but do not perform a restore as part of burn-in.

## Interpreting failures

- Leadership loss or Redis loss: new cycles are refused, the worker shuts down with a
  non-zero result, and the supervisor applies backoff. Do not assume a reconnection
  restores ownership; a new atomic acquisition is required.
- PostgreSQL loss: readiness becomes false and the worker exits when heartbeat
  consistency can no longer be maintained. No migration or repair is attempted.
- Stale heartbeat while supervisor or burn-in is running: `CRITICAL`; stop burn-in and
  inspect logs.
- Stale heartbeat after an intentional `ops:stop`: `WARNING` / `EXPECTED_STOPPED`.
- Crash loop or unexpected supervisor exit: `CRITICAL` / `HUMAN_REVIEW_REQUIRED`.
- Preexisting stale `AutomationRun`: read-only finding. Burn-in does not finish, delete
  or edit it.

## Verification checklist

After stopping, confirm:

```powershell
npm run ops:burn-in:status
npm run ops:burn-in:report
npm run ops:status
npm run ops:audit-state
docker compose ps
```

The accepted result has zero residual processes, zero residual test locks, zero
external-effect events, unchanged business fingerprints, unchanged real worker key,
healthy PostgreSQL/Redis, and the same WhatsApp queue fingerprint. The dashboard
remains read-only and offers no start, stop, backup, task, dispatch or reconciliation
buttons.

If any check fails, preserve `.local/logs` and `.local/ops/burn-in-report.json`, stop
owned processes, and report `HUMAN_REVIEW_REQUIRED`. Do not modify the WhatsApp queue
or business records automatically.
