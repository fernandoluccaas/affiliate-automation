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

SIGINT and SIGTERM stop admission of new components, wait for the active
component to settle, persist an `OFFLINE` heartbeat and only then disconnect
Prisma.

Long-running components refresh the heartbeat while their operation is active.
Each component emits one bounded JSON event with timestamp, component, run ID,
status and duration. Failure events use a fixed error code and never serialize
the thrown error, cookies, tokens, headers or session values.

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

## Telegram retry policy

Telegram timeouts, network failures, HTTP 429 and HTTP 5xx are transient.
Invalid credentials/chat and other HTTP 4xx responses are permanent.

Transient failures use bounded backoff:

```text
1 minute -> 5 minutes -> 15 minutes -> 30 minutes
```

Telegram `Retry-After` is used whenever it is longer than the normal backoff.
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
