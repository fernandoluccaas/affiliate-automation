# Worker operations

## Phase 4 baseline audit

The worker currently has two execution modes:

- `npm run worker:once` executes one complete `runWorkerCycle`.
- `npm run worker:start` and `npm run worker:dev` keep the process alive and
  repeat that same complete cycle every `WORKER_POLL_INTERVAL_MS` (60 seconds by
  default).

Every cycle currently runs offer expiration, Mercado Livre discovery,
affiliate-link jobs, Mercado Livre refresh, publication scheduling, retry
requeueing and publication delivery in sequence. Stage failures are isolated,
recorded in `AutomationRun` and `SystemAlert`, and do not prevent later stages
from running.

### Existing guarantees

- Mercado Livre dashboard imports and worker imports share
  `MercadoLivreDiscoveryService`.
- Discovery already owns a Redis lock and preserves item-level failures.
- Product identity and commercial fingerprints prevent duplicate products and
  unnecessary Offer versions.
- Existing valid affiliate URLs are reused; discovery metrics already expose
  `affiliateLinksReused` and `affiliateLinksGenerated`.
- Publication creation is idempotent for `channel + Offer version`.
- Publication payloads are immutable snapshots.
- A per-publication Redis lock protects scheduling.
- Telegram delivery records `PublicationAttempt`.
- AI failure falls back to the deterministic promotional template.

### Operational gaps found

- There is no root `npm run worker` command.
- All jobs share one polling cadence instead of independent discovery,
  publication, retry and maintenance intervals.
- Daily publication boundaries use the server timezone, not
  `Channel.timezone`.
- Scheduling iterates Offers before Channels and stops after the first
  compatible Channel, preventing the same Offer version from reaching multiple
  compatible channels.
- A zero minimum interval can schedule a burst in one cycle, while scheduled
  publications accumulated before a restart can be delivered in batches of 25.
- READY offers are ordered only by collection time, without the requested
  deterministic score/discount/ranking priority.
- Failed publications are requeued immediately. There is no exponential
  backoff, permanent-error classification or persisted Telegram `Retry-After`.
- Redis-unavailable mode currently treats locks as acquired; there is no
  `WORKER_REQUIRE_REDIS` production mode.
- SIGINT/SIGTERM disconnect Prisma immediately instead of first allowing the
  active job to settle.
- There is no continuously updated heartbeat, stale-worker calculation,
  operational pause state or dashboard worker summary.
- Structured per-cycle diagnostics exist, but continuous-loop metrics do not
  yet aggregate the requested cadence and publication counters.

## Persistence available for Phase 4

`SystemSetting` is a unique key/value store and can persist the singleton worker
heartbeat and global pause flags without a schema change. `AutomationRun`
already stores bounded run metrics and errors. `Publication`,
`PublicationAttempt`, `Channel` and `Offer` already contain the timestamps and
identities needed for recovery, retry scheduling, daily limits and
anti-repetition.

No migration is required for the initial continuous-worker implementation.
Retry scheduling can use the existing `Publication.scheduledAt`, and operational
state can use stable `SystemSetting` keys.

## Continuous runtime

Run the production-style local process with:

```powershell
npm run worker
```

The runtime maintains four independent clocks:

| Component   | Environment variable                  | Default    |
| ----------- | ------------------------------------- | ---------- |
| Discovery   | `WORKER_DISCOVERY_INTERVAL_MINUTES`   | 30 minutes |
| Publication | `WORKER_PUBLICATION_INTERVAL_MINUTES` | 5 minutes  |
| Retry       | `WORKER_RETRY_INTERVAL_MINUTES`       | 10 minutes |
| Maintenance | `WORKER_MAINTENANCE_INTERVAL_MINUTES` | 60 minutes |

Each clock is advanced from the actual execution time. Intervals missed while
the process is offline are not replayed, preventing catch-up loops after a
restart. A failure is isolated to its component and later clocks still run.

The singleton `worker:continuous:status` `SystemSetting` stores heartbeat,
process state, last component outcomes and estimated next executions. The
singleton `worker:continuous:controls` setting stores `discoveryPaused` and
`publicationPaused`. Publication pause also pauses retry delivery, but
maintenance continues.

Operational health is derived centrally from the persisted state and heartbeat:

- `ONLINE`: stored state is not `OFFLINE` and the heartbeat is at most 90
  seconds old;
- `OFFLINE`: a graceful shutdown explicitly persisted `OFFLINE`;
- `STALE`: the process last claimed to be online, but the heartbeat is missing,
  invalid, in the future or older than 90 seconds.

The default heartbeat is 30 seconds, so `STALE` represents three missed
heartbeats. An abrupt process termination cannot persist `OFFLINE`; the
dashboard therefore changes it to `STALE` after that threshold. A restart
persists `ONLINE` before admitting the first component.

SIGINT and SIGTERM stop admission of new components, wait for the active
component to settle, persist an `OFFLINE` heartbeat and only then disconnect
Prisma. Persisting the final state has a five-second bound; a sanitized
`WORKER_OFFLINE_PERSIST_FAILED` event is emitted if that write fails or times
out, so shutdown is not held indefinitely.

Long-running components refresh the heartbeat while their operation is active.
Each component emits one bounded JSON event with timestamp, component, run ID,
status and duration. Failure events use a fixed error code and never serialize
the thrown error, cookies, tokens, headers or session values.

Manual health check:

1. run `npm run worker` and confirm `/automacoes` shows `ONLINE`;
2. stop that exact process with Ctrl+C and confirm `OFFLINE`;
3. for abrupt-exit testing, terminate only the PID displayed by the worker
   status (never use a broad `taskkill /IM node.exe`) and wait 90 seconds;
4. confirm `STALE`, restart `npm run worker`, and confirm `ONLINE`.

## Restart and delivery guarantees

The database side is idempotent: restarting never creates a second Publication
for the same `Channel + Offer version`, and queued rows are drained at one row
per Channel cadence.

Delivery has one unavoidable at-least-once boundary. If the process stops before
calling Telegram, the saved SCHEDULED row is retried safely. If Telegram accepts
the message but the process stops before saving its returned message ID, the
worker cannot prove delivery because the Bot API does not accept an idempotency
key or provide a reliable lookup by the local Publication ID. That row may be
sent again after restart. Publication attempts and external IDs are persisted as
soon as a response is received, minimizing but not eliminating this window.

## Publication distribution

Each publication cadence schedules at most one eligible Offer per Channel and
delivers at most one due Publication per Channel. It does not drain a backlog in
one tick. A compatible Offer version can be scheduled once for each Channel;
the idempotency key remains `channel + Offer version`.

READY offers are sorted deterministically:

1. never published;
2. highest score;
3. highest known discount;
4. best known bestseller position;
5. most recently collected;
6. stable ID.

Unknown discount and ranking values are neutral and sort after known values at
the corresponding priority.

Daily counts use the UTC interval corresponding to midnight-to-midnight in
`Channel.timezone`. Allowed start/end times and minimum intervals continue to
use the same channel policy, including windows that cross midnight.

## Redis coordination

Continuous discovery, publication, retry and maintenance components each use a
distributed lock with an ownership token and bounded TTL. Existing discovery
and per-publication locks remain in place.

Local development stays permissive when Redis is not configured. Production can
require coordination:

```env
WORKER_REQUIRE_REDIS="true"
REDIS_URL="redis://localhost:6379"
```

With required mode enabled, an unavailable Redis instance never returns a
successful lock. The affected component fails safely and is reflected in the
worker heartbeat instead of running without distributed coordination.

Lock outcomes are deliberately distinct:

- `REDIS_UNAVAILABLE`: backend missing, unreachable or failing; the protected
  workload is `FAILED` and does not execute when Redis is required;
- `LOCK_ALREADY_HELD`: Redis answered normally but another worker owns the
  component lock; the workload is `SKIPPED`;
- acquired lock: workload executes and the backend is `AVAILABLE`.

The process stays alive after `REDIS_UNAVAILABLE`. Every cadence performs a new
bounded acquisition, so restoring Redis lets the next cycle run without a
worker restart. `/automacoes` shows the last known lock backend as `AVAILABLE`,
`UNAVAILABLE` or `UNKNOWN` and preserves the sanitized root cause in the worker
status. Lock-failure AutomationRuns store `WORKER_COMPONENT_FAILED` plus
`rootCause: REDIS_UNAVAILABLE` in metrics; held-lock runs store a skipped
outcome rather than an infrastructure failure. Redis URLs, credentials and
connection strings are never included.

`WORKER_REQUIRE_REDIS=false` is the permissive development mode. If Redis is
not configured or becomes unreachable, the local workload may run without a
distributed lock and the status reports an unavailable backend. With
`WORKER_REQUIRE_REDIS=true`, a protected workload never runs unless a real lock
was acquired.

Manual recovery check:

1. start Redis and the worker with `WORKER_REQUIRE_REDIS=true`;
2. confirm a protected component succeeds;
3. run `docker compose stop redis` and wait for the next cadence;
4. confirm `FAILED`, `REDIS_UNAVAILABLE`, and that the workload did not run;
5. run `docker compose start redis` without restarting the worker;
6. confirm the following cadence acquires its lock and succeeds;
7. run a second worker against the same component lock and confirm
   `SKIPPED / LOCK_ALREADY_HELD`, not `REDIS_UNAVAILABLE`.

### Local verification record (2026-07-31)

A local PostgreSQL/Redis Docker environment was used with isolated no-op worker
dependencies, so no discovery, affiliate generation, scheduling or publication
was triggered by the operational probes.

- heartbeat start: `ONLINE`, lock backend `AVAILABLE`;
- graceful abort: `OFFLINE` persisted immediately;
- self-terminated probe: stored state remained `ONLINE`, and the shared resolver
  returned `STALE` at the 90,000 ms threshold;
- restart after the abrupt probe: `ONLINE`, followed by a graceful `OFFLINE`;
- Redis available: protected maintenance workload `SUCCEEDED`;
- Redis stopped: `FAILED / REDIS_UNAVAILABLE`, workload count unchanged;
- Redis started in the same process: next invocation `SUCCEEDED`, no restart;
- deliberately held lock: `SKIPPED / LOCK_ALREADY_HELD`, not an infrastructure
  failure.

The corresponding lock AutomationRuns contained only fixed operational fields:
`WORKER_COMPONENT_FAILED + REDIS_UNAVAILABLE + UNAVAILABLE` and
`WORKER_COMPONENT_SKIPPED + LOCK_ALREADY_HELD + AVAILABLE`.

An isolated real Mercado Livre refresh selected 25 current Offers, all classified
as catalog PRODUCT identities. It refreshed all 25, preserved 25 affiliate URLs,
reused 16 Offer versions, created 9 new commercial versions, used catalog-summary
price fallback 25 times and reported zero not-found, zero unavailable prices and
zero failures. Optional detail enrichment was unavailable for all 25 and did not
prevent a `SUCCEEDED` AutomationRun.

## Telegram retry policy

Telegram timeouts, network failures, HTTP 429 and HTTP 5xx are transient.
Invalid credentials/chat and other HTTP 4xx responses are permanent.

Transient failures use bounded backoff:

```text
1 minute -> 5 minutes -> 15 minutes -> 30 minutes
```

Telegram `Retry-After` is used whenever it is longer than the normal backoff.

## Assisted WhatsApp Groups runbook

1. Apply migrations and create a `WHATSAPP_GROUPS` record in `/canais`, or explicitly convert a legacy `WHATSAPP_CHANNEL` record on that page.
2. Keep `publicationMode=ASSISTED`. Recommended initial settings are daily limit 3, minimum interval 60 minutes and maximum 3 pending publications.
3. Run `npm run worker:once` (or the workspace equivalent).
4. Open `/publicacoes-assistidas`; verify the exact snapshot, affiliate URL and image.
5. Copy only through the user-triggered button, download the image and open `https://web.whatsapp.com/`.
6. Select and publish manually in the intended group, then click `Marcar como publicada` and confirm the snapshotted group name.
7. Run the worker again and verify the same group plus Offer version is not duplicated. A second configured group remains independently eligible.

An awaiting item reserves one daily slot and the worker creates no more than `WHATSAPP_ASSISTED_MAX_PENDING_PER_CHANNEL` pending rows (default 5). The image download endpoint permits HTTPS images only, rejects local/private literal addresses and unsafe redirects, validates the media type, enforces timeout and size limits, and does not expose a server path.

The assisted flow remains the stable fallback. The experimental Web flow has a separate local runbook:

1. Start PostgreSQL and Redis and keep the feature disabled while configuring the group.
2. Install Chromium once with `npm run whatsapp:web:install-browser`.
3. In `/canais`, set the exact group name and logical profile key, confirm ownership, then activate Web experimental mode.
4. Set `WHATSAPP_GROUPS_WEB_EXPERIMENTAL_ENABLED=true` and keep `WHATSAPP_WEB_DRY_RUN=true`.
5. Authenticate manually with `npm run whatsapp:web:login -- --profile principal`. Scan the QR only in the visible browser; it is never captured.
6. Run `npm run whatsapp:web:health -- --profile principal`, then `npm run whatsapp:web:diagnose -- --profile principal`, and finally `npm run whatsapp:web:locate -- --channel-id <id>`. Diagnose does not type, open a conversation or create a draft; locate uses the persisted exact group name and does not prepare content.
7. Run `npm run whatsapp:web:dry-run -- --publication-id <id>`. It must return `READY_TO_SEND`; no send button is called and the draft must be cleared.
8. Run `npm run whatsapp:web:preflight -- --publication-id <id>`. It must return `READY_TO_COMMIT_SEND`, report one visible and enabled trigger scoped to the current media editor, never click it, and clear the draft.
9. After human review only, set `WHATSAPP_WEB_DRY_RUN=false` and run `npm run whatsapp:web:publish -- --publication-id <id> --confirm-send`. Omitting `--confirm-send` refuses delivery. Once `sendClickStartedAt` exists, automatic retry remains blocked even if the click result is unknown.

Redis is mandatory for Web mode. Missing Chromium reports `WHATSAPP_WEB_BROWSER_UNAVAILABLE`; missing login, selector mismatch, ambiguity or permission errors pause only the affected group. After the first confirmed success the group auto-pauses with `WHATSAPP_WEB_FIRST_SUCCESS_REVIEW_REQUIRED`. If send was clicked but confirmation is inconclusive, verify the group manually and use the authenticated review actions; retry stays blocked until explicitly authorized.

Selector failures expose a sanitized `stage` such as `SEARCH_INPUT_NOT_FOUND`, `SEARCH_RESULTS_NOT_READY`, `GROUP_HEADER_MISMATCH` or `COMPOSER_NOT_FOUND`. For local visual diagnosis only, `WHATSAPP_WEB_SLOW_MO_MS` may slow Playwright and `WHATSAPP_WEB_KEEP_OPEN_ON_ERROR=true` may keep a failed diagnose/locate browser open for the bounded `WHATSAPP_WEB_KEEP_OPEN_ON_ERROR_TIMEOUT_MS`; both default to inert, never affect the continuous worker, and never disable final browser/lock cleanup.

Media dry-run failures preserve a specific sanitized stage (`ATTACH_TRIGGER_NOT_FOUND`, `IMAGE_OPTION_NOT_FOUND`, `FILE_CHOOSER_NOT_OPENED`, `MEDIA_PREVIEW_NOT_FOUND`, `CAPTION_INPUT_NOT_FOUND`, `DRAFT_VALIDATION_FAILED` or `DRAFT_CLEANUP_FAILED`) instead of collapsing to a selector mismatch. Inspect only `webLastDryRunStage` and `webLastDryRunDiagnostics`; these fields contain structural booleans, strategy, temporary file size/extension and duration, never the temporary path, group name, caption, conversations or session secrets.

To recover an expired session, rerun the login command against the same logical profile. To erase a local session, stop every command holding that profile lock and remove only its directory below `.local/whatsapp-web`; never copy, archive or commit it. Debug screenshots are off by default and can expose private content when explicitly enabled.
The retry timestamp is persisted in `Publication.scheduledAt`. A Channel with a
pending transient failure is not used for another delivery until that timestamp
passes. Permanent failures become `PUBLICATION_FAILED` immediately; transient
failures stop after four attempts. Only one failed row per Channel is requeued
in a retry cadence.

## Running the automation continuously

### Windows development

Terminal A:

```powershell
docker compose up -d
```

Terminal B:

```powershell
npm run dev
```

Terminal C:

```powershell
$env:WORKER_DISCOVERY_INTERVAL_MINUTES="5"
$env:WORKER_PUBLICATION_INTERVAL_MINUTES="2"
$env:WORKER_RETRY_INTERVAL_MINUTES="2"
$env:WORKER_MAINTENANCE_INTERVAL_MINUTES="15"
$env:WORKER_REQUIRE_REDIS="true"
npm run worker
```

Use `/automacoes` to confirm the heartbeat, next executions and counters.
Pause publication before testing discovery alone. Stop with Ctrl+C and confirm
that the status changes to OFFLINE after the active component finishes.

### Linux service

Provide the same variables through the process manager and execute:

```bash
npm run worker
```

The process manager should restart unexpected exits and send SIGTERM during
deployments. PostgreSQL and Redis must be reachable before starting when
`WORKER_REQUIRE_REDIS=true`.

### Manual verification checklist

With a dedicated Telegram test Channel:

1. Confirm that discovery updates offers at the configured cadence.
2. Confirm that at most one message per Channel is sent in each publication
   cadence.
3. Confirm that different headlines and valid `meli.la` URLs are preserved.
4. Stop and restart the worker with a backlog; confirm there is no burst.
5. Pause only publication and confirm discovery continues.
6. Resume publication and confirm normal cadence instead of backlog draining.
7. Stop Ollama and confirm `aiFallbackUsed` increases without stopping delivery.

## Safety boundary

Continuous operation must reuse the validated Mercado Livre discovery service
and affiliate-link provider. It must not add a second discovery path, regenerate
valid `meli.la` links, expose session secrets or broaden the authorized
affiliate-session endpoints.
