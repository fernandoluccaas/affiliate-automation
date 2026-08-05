# Windows local production operations

Phase 5F runs the durable application locally on Windows 10/11. PostgreSQL and
Redis run in Docker Desktop; the production Next.js dashboard and continuous
Node worker run on the host under a PowerShell supervisor. WhatsApp Web remains
a separate, headed, owner-initiated operation and is never started by the
supervisor, worker, dashboard, backup task, or Task Scheduler.

## Process model and safety boundary

| Layer | Continuous | Components | Browser or WhatsApp dispatch |
| --- | --- | --- | --- |
| Docker infrastructure | yes | PostgreSQL, Redis | never |
| Host application | yes | production dashboard, continuous worker | never |
| Manual operations | no | login, inspect draft, preflight, unit authorization, dispatch, reconciliation | only in an attended session |

Keep `WHATSAPP_WEB_DRY_RUN="true"` for normal operation. The worker plans and
defers Web Publications but never imports Playwright or consumes a send
authorization. Telegram continues independently when a WhatsApp queue is
blocked, awaiting inspection, claimed, or in `DELIVERY_UNCERTAIN`.

## First startup

1. Install Node.js 20 or newer, npm, Docker Desktop, and PostgreSQL client tools
   supplied by the Compose image.
2. Configure `.env`; do not put secrets in PowerShell scripts or scheduled task
   arguments. Set the Compose `POSTGRES_USER`, `POSTGRES_PASSWORD`, and
   `POSTGRES_DB` values consistently with `DATABASE_URL` when invoking Compose
   directly.
3. Start Docker Desktop and run `docker compose up -d`. Both published ports are
   bound to `127.0.0.1`.
4. Run `npm install`, `npm run prisma:generate`, and inspect
   `npx prisma migrate status --schema prisma/schema.prisma`.
5. If migrations are pending, apply them manually using the documented deploy
   procedure. `ops:preflight` never applies migrations.
6. Run `npm run production:build`, then `npm run ops:preflight`.
7. Start the host processes with `npm run ops:start` and inspect
   `npm run ops:status` or `/operacoes`.

Production commands:

```powershell
npm run production:build
npm run production:dashboard
npm run production:worker
npm run ops:preflight
npm run ops:start
npm run ops:stop
npm run ops:restart
npm run ops:status
npm run ops:audit-state
```

Do not use `npm run dev` for continuous operation. The dashboard listens on
`127.0.0.1:3000` by default. `ops:preflight` rejects an unknown owner of that
port; a supervisor-recorded dashboard process is accepted.

## Supervisor and shutdown

`scripts/ops/supervisor.ps1` maintains one supervisor instance using an
exclusive local lock. Its state and component instance IDs live below
`.local/ops`; no token or connection string is written there. It validates the
repository and component marker before stopping a PID, so a stale file cannot
cause an unrelated Node process to be terminated.

An unexpected component exit uses progressive backoff. After
`AFFILIATE_SUPERVISOR_MAX_CRASHES` consecutive failures that component becomes
`FAILED`, while the other component remains supervised. Status shows the
required manual action instead of hiding a permanent failure.

`npm run ops:stop` creates a cooperative stop request. Each process host signals
its child first and waits up to `AFFILIATE_SHUTDOWN_TIMEOUT_SECONDS`; only then
does the supervisor force termination. The worker stops admitting cycles,
finishes safe in-flight work, and releases the Redis leader lock only through
its ownership-checked handle. Shutdown never releases a WhatsApp dispatch claim
or changes delivery state.

The safe supervisor test uses fake sleeping children:

```powershell
npm run ops:supervisor:smoke
```

It validates local PIDs and a supervised restart, exits after 20 seconds, runs
no jobs, opens no browser, and publishes no external message.

## Worker leadership and heartbeat

Before starting the continuous loop, a worker must acquire
`affiliate:worker:leader` in Redis. The value is an in-memory random ownership
token, never a PID and never logged. The default TTL is 45 seconds, bounded to
15–300 seconds and configurable with `WORKER_LEADER_TTL_SECONDS`. Renewal runs
approximately every one-third TTL. Release and extension compare the token;
loss of ownership aborts the loop safely.

A second worker returns `WORKER_ALREADY_ACTIVE` without scheduler, PlanningRun,
Publication, Telegram, or browser work. Redis is mandatory for this global
leader even if a development component lock is permissive. Redis failure
therefore fails the worker closed while the dashboard remains available and
reports the dependency error.

The existing `worker:continuous:status` database singleton is the sole
heartbeat. It contains sanitized instance/build/cycle/timing fields, leader
state, uptime, and fixed error codes. It contains no PID, lock token, payload,
URL, cookie, or message. A missing or old heartbeat becomes `STALE` after the
shared threshold; status and audit report it without changing Publications.

## Health, readiness, status, and audit

- `GET /api/health/live` proves only that the dashboard process responds. It
  does not query PostgreSQL, Redis, or WhatsApp.
- `GET /api/health/ready` checks database, Redis, migrations, build, and worker
  heartbeat through a sanitized response.
- `npm run ops:status` is read-only and reports supervisor PID/uptime, dashboard
  readiness, dependencies, worker instance/leadership/heartbeat/cycle, latest
  AutomationRun, latest backup, log summary, and aggregate WhatsApp queue state.
- `npm run ops:audit-state` is read-only. It never releases claims or edits
  metadata.

Audit severities are `INFO`, `WARNING`, `CRITICAL`, and
`HUMAN_REVIEW_REQUIRED`. The audit identifies stale heartbeat/backup/runs,
claimed pre-click authorization, a click already started, unresolved delivery,
multiple operationally active Publications in one channel, expired active
authorization, and paused channels without a reason. A normal waiting backlog
is not mistaken for multiple active executions.

Operational responses:

- `CLAIMED` without `sendClickStartedAt`: inspect the publication, then use the
  Phase 5E manual release command with actor, reason, and confirmation only if
  it is proven pre-click. Startup never releases it.
- `SEND_IN_PROGRESS` with a click marker or `DELIVERY_UNCERTAIN`: reconcile
  delivery manually. Never retry automatically.
- stale heartbeat: inspect `ops:status` and logs; restart through the supervisor.
  Do not edit Publication status.
- stale backup: run `ops:backup-db`, then verify the generated file.

The authenticated `/operacoes` page exposes the same safe summary and copyable
read-only commands. It cannot start/stop a process, back up the database, change
dry-run, release a claim, open a browser, or dispatch.

## Logs

Local logs are under `.local/logs`. The supervisor writes structured records
with timestamp, component, level, event, abbreviated instance ID, and safe error
code. Dashboard and worker stdout/stderr are separately identified JSONL files.
The process host deliberately stores only each output line's length and a short
SHA-256 content hash—not the original line—preventing message, group, URL, or
secret disclosure.

Rotation is bounded by `AFFILIATE_LOG_MAX_MB` and
`AFFILIATE_LOG_RETENTION_DAYS`. Open Windows log handles are skipped, never
truncated or forced. `ops:status` reports only the logical directory name,
aggregate size, latest basename, write status, and retention.

## PostgreSQL backups

`npm run ops:backup-db` acquires an exclusive local backup lock, streams a
custom-format `pg_dump` from the Compose PostgreSQL service into a temporary
file, rejects an error/empty dump, validates it with `pg_restore --list`, hashes
it with SHA-256, atomically renames it, and writes a secret-free manifest. A
failed attempt deletes only its temporary file and preserves existing backups.

```powershell
npm run ops:backup-db
npm run ops:backup-status
npm run ops:verify-backup -- --file C:\path\configured-backups\affiliate-....dump
```

The default directory is `.local/backups`; production may set an external
`AFFILIATE_BACKUP_DIR`. Retention defaults to 30 days and 14 files via
`AFFILIATE_BACKUP_RETENTION_DAYS` and
`AFFILIATE_BACKUP_RETENTION_COUNT`. Verification is read-only and accepts only
files inside the configured directory. Backups contain PostgreSQL only: no
`.env`, logs, browser profile, WhatsApp session, or filesystem secret.

Manual restore procedure (never run by startup or supervisor):

1. stop the application and preserve the current database;
2. run `ops:verify-backup` on an explicitly selected file;
3. create a separate, empty recovery database with a separate URL;
4. use `pg_restore` against that recovery database, never the live URL by
   default;
5. validate migrations and business counts in the recovery database;
6. switch only after a documented owner-approved maintenance decision.

Never use `docker compose down -v` for recovery and never overwrite the live
database as a test.

## Optional Task Scheduler integration

Preview commands do not modify Windows:

```powershell
npm run ops:task-supervisor:preview
npm run ops:task-backup:preview
```

Installation/removal is optional and requires the explicit trailing flag:

```powershell
npm run ops:task-supervisor:install -- --confirm-install
npm run ops:task-supervisor:remove -- --confirm-remove
npm run ops:task-backup:install -- --confirm-install
npm run ops:task-backup:remove -- --confirm-remove
```

The supervisor task runs at owner logon; the backup task runs daily. Neither
contains credentials, performs installation/migration/git pull, starts
Playwright, or dispatches WhatsApp. The backup lock prevents overlapping dumps.
Docker Desktop must already be running. After reboot, startup may depend on the
owner logging into Windows; do not enable insecure automatic login. A graphical,
unlocked desktop is needed only for attended WhatsApp operations.

## Power-loss recovery and safe mode

After an abrupt shutdown, Docker restart policies recover PostgreSQL and Redis
when Docker Desktop starts. Start or inspect the supervisor, then run preflight
and the state audit. The audit, not an automatic repair, identifies abandoned
human states. No WhatsApp Publication is presumed delivered and no send retry
is admitted.

Immediate safe mode is:

1. keep `WHATSAPP_WEB_DRY_RUN="true"`;
2. disable the experimental WhatsApp feature flag if needed;
3. leave Telegram/dashboard infrastructure independent;
4. use assisted WhatsApp as the fallback;
5. stop host processes with `npm run ops:stop` if shared state is unsafe.

## Operational checklist

Daily:

- confirm Docker Desktop, PostgreSQL, and Redis health;
- inspect `ops:status`, heartbeat, latest cycle, and backup age;
- review `DELIVERY_UNCERTAIN`, click-started, claimed, and paused-channel alerts;
- keep dry-run true except during a separately authorized attended operation.

Weekly:

- run `ops:audit-state` and `ops:backup-status`;
- verify the newest backup explicitly;
- inspect disk/log sizes and supervisor crash counters;
- confirm no task or worker invokes browser/dispatch.

Monthly:

- test restoration into an isolated recovery database;
- review retention and free-space thresholds;
- review Node/Docker security updates without force-fixing dependencies;
- verify Task Scheduler definitions and owner authorization;
- confirm the assisted fallback remains usable.
