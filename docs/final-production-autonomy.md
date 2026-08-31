# Final production autonomy

Phase 6A.17 adds the fail-closed production shell around the existing Mercado
Livre, Shopee, Telegram and WhatsApp pipelines. It does not enable any external
integration by default and it does not replace marketplace discovery, offer
versioning, scheduler policies, Telegram delivery or the existing WhatsApp
queue.

## Process boundaries

Production uses three logical processes:

1. Dashboard: authenticated UI, `/go/<slug>` tracking and read-only operations.
2. Main worker: marketplace discovery, affiliate linking, freshness, planning,
   Telegram transport and WhatsApp queue planning.
3. WhatsApp Automation Runner: the only continuous process that may open the
   existing Playwright-based WhatsApp publisher. It uses the existing queue,
   claims, Publication attempts, channel/profile/publication locks and
   `DELIVERY_UNCERTAIN` policy.

The runner has its own Redis singleton key. A failure or lock loss in that
runner does not stop the main worker or Telegram. The supervisor starts the
runner only when `WHATSAPP_AUTOMATION_ENABLED=true` and the mode is explicitly
`DRY_RUN` or `LIVE`. Smoke and burn-in modes never start it.

## Go-live switches

Defaults are intentionally safe:

```env
PRODUCTION_AUTONOMY_MODE="OFF"
PUBLIC_TRACKING_BASE_URL=""
PUBLIC_TRACKING_REQUIRE_STABLE_URL="true"
WHATSAPP_AUTOMATION_ENABLED="false"
WHATSAPP_AUTOMATION_MODE="OFF"
```

Unknown or missing modes resolve to `OFF`. Real WhatsApp sends require all of:

- `WHATSAPP_AUTOMATION_ENABLED=true`;
- `WHATSAPP_AUTOMATION_MODE=LIVE`;
- `WHATSAPP_GROUPS_WEB_EXPERIMENTAL_ENABLED=true`;
- `WHATSAPP_WEB_DRY_RUN=false`;
- a healthy authenticated persistent profile;
- an enabled, unpaused, owner-confirmed `WEB_EXPERIMENTAL` group;
- the active queue-head Publication with no previous attempt or click marker;
- no unresolved `DELIVERY_UNCERTAIN` in that channel;
- Redis leadership and operational locks;
- a stable public tracking URL and all message/link/freshness gates.

`DRY_RUN` performs health and structural preflight and always returns with
`sendCalled=false`. It never creates an automatic send authorization and never
calls dispatch. `OFF` does not load the automation runtime.

## Stable public tracking

Set `PUBLIC_TRACKING_BASE_URL` to a permanent HTTPS origin, without credentials,
query, fragment or an application path. LIVE rejects localhost, private hosts
and `*.trycloudflare.com`. `/go/<slug>` remains the only generated tracking path;
its destination remains the active canonical AffiliateLink.

Quick Tunnels are development-only. For a future fixed Cloudflare Named Tunnel,
configure only local environment values:

```env
CLOUDFLARE_NAMED_TUNNEL_ENABLED="false"
CLOUDFLARE_TUNNEL_NAME=""
CLOUDFLARE_PUBLIC_HOSTNAME=""
```

The repository never stores a tunnel token or credential. Available commands:

```powershell
npm run tracking:tunnel:status
npm run tracking:tunnel:preflight
npm run tracking:tunnel:run
```

`preflight` checks the local dashboard and the configured public `/go` endpoint.
It does not provision a tunnel, log in to Cloudflare or change DNS. `run` invokes
only `cloudflared tunnel run <configured-name>` after explicit configuration.

## Publication safety gates

Before Publication creation and again immediately before Telegram or WhatsApp
transport, the shared gates verify:

- non-empty, size-bounded NFC text;
- no replacement character, common double-decoding sequence or suspicious
  box-drawing character (`OUTBOUND_TEXT_MOJIBAKE`);
- immutable title, price and tracking snapshots;
- an active canonical marketplace AffiliateLink;
- Mercado Livre host on the configured allowlist or exact Shopee host
  `s.shopee.com.br`;
- HTTPS, no embedded credentials and no AffiliateLink pointing back to `/go`.

The original product URL is never used as an affiliate fallback. An invalid
Offer remains available for audit but cannot be planned or transported.
Historical `PUBLISHED` snapshots are not rewritten.

## WhatsApp automatic lifecycle

For one active queue-head item, the runner performs session health, exact-group
preflight, draft preparation and cleanup, persists an automatic inspection and
preflight audit, then creates a short-lived authorization bound to Publication,
Channel, fingerprint, marketplace and runner instance. The existing atomic
claim and dispatch service performs the actual send.

The click-start marker is the no-return boundary. A pre-click failure is safe;
any ambiguity after it becomes `DELIVERY_UNCERTAIN`, pauses that channel and
requires explicit reconciliation. There is no automatic retry or automatic
reconciliation. Manual commands (`health`, `diagnose`, `inspect-draft`,
`preflight`, `authorize-send`, `dispatch-authorized`, `resolve-delivery`,
`cancel` and `archive`) remain available as fallback.

Commands:

```powershell
npm run production:status
npm run production:preview
npm run mercadolivre:status
npm run shopee:production:status
npm run tracking:status
npm run tracking:preflight
npm run whatsapp:auto:status
npm run whatsapp:auto:preflight
npm run whatsapp:auto:once
npm run whatsapp:auto:start
npm run whatsapp:auto:stop
npm run ops:preflight
npm run ops:status
```

`production:preview` and status commands are read-only and make no marketplace
or messaging request. `whatsapp:auto:once` is dangerous only after every LIVE
switch has been explicitly enabled; there is no implicit LIVE mode.

## Windows startup and recovery

The existing supervisor task is `AT LOGON`, which is required by the graphical
WhatsApp session. Preview it with `npm run ops:task-supervisor:preview`.
Installation and removal remain protected by explicit confirmation in the
existing task CLI; this phase does not install a task.

The supervisor optionally manages the runner and named tunnel with bounded
restart backoff. Defaults keep both absent. PostgreSQL/Redis failure, runner
singleton contention, invalid tracking, missing WhatsApp login, selector
mismatch and unresolved delivery all fail closed. Review `/operacoes`,
`ops:status` and `ops:audit-state`; recovery never sends, retries, changes DNS or
reconciles delivery automatically.
