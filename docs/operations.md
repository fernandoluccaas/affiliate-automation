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

## Safety boundary

Continuous operation must reuse the validated Mercado Livre discovery service
and affiliate-link provider. It must not add a second discovery path, regenerate
valid `meli.la` links, expose session secrets or broaden the authorized
affiliate-session endpoints.
