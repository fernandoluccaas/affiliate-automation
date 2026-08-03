# Grupos do WhatsApp

## Modo assistido

`WHATSAPP_GROUPS` represents one owner-administered group per Channel. `ASSISTED` remains the stable default: the shared scheduler creates an immutable `AWAITING_MANUAL_PUBLICATION` snapshot, and the authenticated operator copies the exact message, optionally downloads the safely validated image and confirms the manual outcome in `/publicacoes-assistidas`.

The affiliate URL appears exactly once and is never replaced by the product URL. Each group has independent limits, window, timezone, product repetition and idempotency. `WHATSAPP_CHANNEL` is legacy; `WHATSAPP_GROUPS_API`, Cloud API and individual recipients are not used.

## Modo Web experimental

This is local Playwright UI control, not an official WhatsApp API. It is optional, disabled by default and restricted to groups the repository owner belongs to or administers. It never automates login credentials, SMS, PIN, MFA or CAPTCHA; never captures QR codes; never exports cookies/local storage; and never reads conversation history, members, phone numbers or invitation links.

### Safe defaults

```dotenv
WHATSAPP_GROUPS_WEB_EXPERIMENTAL_ENABLED="false"
WHATSAPP_WEB_DRY_RUN="true"
WHATSAPP_WEB_HEADLESS="false"
WHATSAPP_WEB_USER_DATA_ROOT=".local/whatsapp-web"
WHATSAPP_WEB_DEBUG_ROOT=".local/whatsapp-debug"
WHATSAPP_WEB_DEBUG_SCREENSHOTS="false"
WHATSAPP_WEB_ACTION_TIMEOUT_MS="30000"
WHATSAPP_WEB_NAVIGATION_TIMEOUT_MS="60000"
WHATSAPP_WEB_CONFIRMATION_TIMEOUT_MS="20000"
WHATSAPP_WEB_PROFILE_LOCK_TTL_SECONDS="180"
WHATSAPP_WEB_MAX_PUBLICATIONS_PER_RUN="1"
WHATSAPP_WEB_AUTO_PAUSE_AFTER_FIRST_SUCCESS="true"
WHATSAPP_WEB_ALLOW_TEXT_FALLBACK="true"
WHATSAPP_WEB_SLOW_MO_MS="0"
WHATSAPP_WEB_KEEP_OPEN_ON_ERROR="false"
WHATSAPP_WEB_KEEP_OPEN_ON_ERROR_TIMEOUT_MS="30000"
WHATSAPP_WEB_DEVTOOLS="false"
```

Profiles and debug output are Git-ignored. `webProfileKey` accepts only ASCII letters, digits, hyphen and underscore and is resolved below the configured root. Do not point it at or copy a personal browser profile.

### Planejamento controlado pelo worker

`npm run worker:once` may persist a Web Publication while `WHATSAPP_WEB_DRY_RUN=true`, but it does not launch Chromium, prepare a draft or call the Web publisher. Planning uses the immutable Offer snapshot and the idempotency key `publication:{channelId}:{offerId}`, so it is independent per channel and per Offer version. A Telegram Publication for the same Offer neither blocks nor replaces the WhatsApp decision.

The new row keeps database status `SCHEDULED` and records `whatsappWebState=AWAITING_VISUAL_INSPECTION`, the planning run, mandatory visual-inspection/preflight gates, `realSendAuthorized=false` and `dispatchBlockedReason=VISUAL_DRAFT_INSPECTION_REQUIRED`. Disabled or paused channels are rejected before planning. Existing `DELIVERY_UNCERTAIN` state remains blocked and is never retried by the scheduler.

`/publicacoes` displays the badge **AGUARDANDO INSPEÇÃO VISUAL**, immutable snapshot identifiers, price, affiliate URL, image, gates, latest attempt/error and only copyable no-send inspection commands. The dashboard does not run those commands or open a browser. Re-running the worker does not create another Publication for the same channel and Offer version.

### Local commands

```bash
npm run whatsapp:web:install-browser
npm run whatsapp:web:login -- --profile principal
npm run whatsapp:web:health -- --profile principal
npm run whatsapp:web:diagnose -- --profile principal
npm run whatsapp:web:diagnose -- --channel-id <CHANNEL_ID>
npm run whatsapp:web:locate -- --channel-id <CHANNEL_ID>
npm run whatsapp:web:dry-run -- --publication-id <PUBLICATION_ID>
npm run whatsapp:web:preflight -- --publication-id <PUBLICATION_ID>
npm run whatsapp:web:inspect-layout -- --publication-id <PUBLICATION_ID> --hold-ms 30000
npm run whatsapp:web:inspect-draft -- --publication-id <PUBLICATION_ID> --hold-ms 20000
npm run whatsapp:web:inspect-delivery -- --publication-id <PUBLICATION_ID> --hold-ms 20000
npm run whatsapp:web:resolve-delivery -- --publication-id <PUBLICATION_ID> --delivered --confirm-delivered --reason "Confirmada visualmente"
npm run whatsapp:web:config-check -- --publication-id <PUBLICATION_ID>
npm run whatsapp:web:queue-status -- --channel-id <CHANNEL_ID>
npm run whatsapp:web:authorize-send -- --publication-id <PUBLICATION_ID> --expires-in-minutes 15
npm run whatsapp:web:revoke-send-authorization -- --publication-id <PUBLICATION_ID> --reason "motivo"
npm run whatsapp:web:cancel-publication -- --publication-id <PUBLICATION_ID> --reason "motivo"
npm run whatsapp:web:archive-publication -- --publication-id <PUBLICATION_ID> --reason "motivo"
npm run whatsapp:web:publish -- --publication-id <PUBLICATION_ID> --confirm-send
```

Login opens visible Chromium and waits for manual QR interaction without capturing it. Health detects authenticated UI, not HTTP 200. Locate uses the persisted `groupDisplayName`, whitespace-only normalization, exact matching, opened-title verification and composer permission; it never accepts a CLI group-name override or chooses the first ambiguous result.

Diagnose by profile recognizes the authenticated shell and global-search controls without typing or opening a conversation. Diagnose by channel performs only the same exact locate validation. Diagnostics contain structural stage, language, strategy/count flags and timing; they never contain chat names, messages, phone numbers, HTML, QR data or session secrets. `WHATSAPP_WEB_SLOW_MO_MS` is visual assistance only. `WHATSAPP_WEB_KEEP_OPEN_ON_ERROR` applies only to explicit local `diagnose` and `locate` commands, is bounded by the configured timeout (maximum 60 seconds), and still closes the browser and releases the Redis lock.

Dry-run requires the feature flag, ownership confirmation, connected session, Redis, exact group and `WEB_EXPERIMENTAL`. It prepares the safe image or configured text fallback, fills the immutable Publication snapshot, checks the unique title snippet and affiliate URL, does not invoke send, clears the draft and persists a configuration fingerprint. A change to channel ID, group name, profile key, mode or `sendImage` invalidates that fingerprint.

Preflight is the final safe check while `WHATSAPP_WEB_DRY_RUN=true`. It resolves the active media editor from multiple anchors instead of requiring one simple ancestor: visible preview, close/send controls, top-level surface, stacking contexts, geometric adjacency and contenteditables captured before and after opening media. A candidate still needs caption semantics and editability; geometry alone never validates it. Existing background composers, hidden or covered nodes, different stacking contexts and ambiguous candidates fail closed. The final contenteditable must have a positive bounding box, be topmost at its center, remain attached, receive focus and preserve the exact snapshot through two observations. Preflight then revalidates one affiliate URL, the title snippet, upload state and exactly one visible, enabled, topmost send trigger. It performs only Playwright's trial click, never the real click, and clears the draft before closing the browser and releasing the Redis lock.

`inspect-layout` captures structural fingerprints of visible contenteditables before attachment, opens the media preview, compares the post-preview layout and reports only sanitized tags, roles, bounding boxes, computed-style fields, hashed class names, data-attribute names and anchor relationships. It never reads message text, fills a caption or sends. It holds the browser and lock for 5–60 seconds (30 seconds by default), including unresolved layouts, then clears the draft and temporary media. Use `--devtools` or local-only `WHATSAPP_WEB_DEVTOOLS=true` only with `inspect-layout`/`inspect-draft`; this opens Chromium DevTools locally and is never consumed by the continuous worker or publish. Do not copy cookies, storage, QR codes, messages or unrelated conversation data from DevTools.

`inspect-draft` performs the same safe preparation and validation, keeps the browser and Redis lock for 5–60 seconds (20 seconds by default), and asks whether the complete image and caption are visibly correct. If preview opens but no caption target is confirmed, it does not fill any candidate and still holds for local inspection, returning `VISUAL_LAYOUT_INSPECTION_REQUIRED`. It never clicks Send. A negative human answer returns `VISUAL_DRAFT_REJECTED`; a positive answer stores only a timestamp and fingerprint over channel configuration plus hashed message/image snapshot identities. Any changed channel, message or image invalidates it. During this experimental phase, a current human-confirmed visual fingerprint is an additional real-send prerequisite; absence returns `WHATSAPP_WEB_VISUAL_DRAFT_INSPECTION_REQUIRED` before media, lock or browser.

`config-check` is a read-only, sanitized eligibility check. It does not acquire media, the profile lock or open Chromium, and reports the effective global dry-run flags, channel authorization state, dry-run fingerprint validity, Publication eligibility and one specific blocking reason. It never returns the group name, profile path, message, URL or session data. The publish command performs the same check before every side effect; for example, `WHATSAPP_WEB_DRY_RUN=true` returns `WHATSAPP_WEB_REAL_SEND_DISABLED_BY_DRY_RUN` with `browserOpened=false`.

The Phase 5D operational queue allows exactly one active non-terminal Publication per Web channel. Existing later rows are shown as `BLOCKED_BY_ACTIVE_PUBLICATION`; they are neither modified nor failed. Ordering is deterministic (`plannedAt`, `createdAt`, ID), and unresolved `DELIVERY_UNCERTAIN` blocks the channel. Planning is protected by Redis and a database row lock, so concurrent workers cannot create two active rows. Queue/control command output contains IDs, counts and states only.

Positive `inspect-draft` and `preflight` results advance only the active item and persist fingerprints without content or session secrets. `authorize-send` creates one expiring, revocable authorization bound to the exact Publication/channel/fingerprint; repeated authorization is idempotent. The future publish path refuses missing, expired, revoked, consumed or mismatched authorization before browser launch and atomically moves a valid authorization to `CLAIMED`. Dashboard control actions perform database transitions only and never instantiate Playwright.

For a confirmed real execution, metadata records `sendClickStartedAt` before invoking the click and `sendWasClicked`/`sendClickedAt` immediately after it returns. A failure or crash after initiation is never treated as a safe retry: the Publication is blocked as `DELIVERY_UNCERTAIN` until explicit review and authorization. The pre-click baseline now contains only structural hashes, order, media type and delivery state for visible outgoing messages. Confirmation recognizes both a new element and an optimistic element whose fingerprint/state changed, reconstructs only the candidate's own rendered text and links, and requires the affiliate URL, unique title snippet, expected media, coherent order/timestamp and no pending/error state. Full message content and URLs are not persisted in diagnostics.

`inspect-delivery` is a no-send diagnostic for an already attempted `DELIVERY_UNCERTAIN` Publication. It uses the persisted click timestamp and immutable snapshot, opens only the configured exact group under the Redis/profile lock, examines visible outgoing candidates, returns sanitized signal booleans, and never prepares media, creates a draft, clicks Send or changes the Publication. `resolve-delivery` never opens Chromium. Delivered resolution requires both `--delivered` and `--confirm-delivered`; it preserves the original attempt, automatic error/stage and click timestamps, adds actor/time/reason audit metadata, marks the Publication and Offer published idempotently, keeps retry disabled and applies the first-success auto-pause. The authenticated `/publicacoes` flow offers delivered, not delivered and keep inconclusive with explicit confirmation. Not-delivered does not authorize retry; retry is a separate second confirmed action.

Image dry-run validates the downloaded temporary file (regular file, non-zero size, supported image MIME and compatible extension), selects the semantic Photos & videos action, uses Playwright's file chooser when available or the scoped image input fallback, waits for the media preview and only then fills the caption. The local file is removed only after draft cleanup. Results expose sanitized media stages and structural flags such as the upload strategy, file size/extension, preview, caption, validation and cleanup; paths, group names, message contents and session data are never included. A failed partial draft is still cleared before the browser and Redis lock are released.

Real send is compiled but not executed by tests. Before media acquisition, profile locking or browser launch, it requires `WHATSAPP_WEB_DRY_RUN=false`, `--confirm-send`, the global feature, a `WHATSAPP_GROUPS` enabled/unpaused channel in `WEB_EXPERIMENTAL`, automation and ownership confirmation, a current successful dry-run fingerprint, an eligible unpublished Publication and explicit retry authorization for prior failed or uncertain delivery state. Immediately before recording `sendClickStartedAt`, it repeats the DOM caption, affiliate URL, title, preview, upload-state and unique send-trigger checks. At most one Web Publication is processed per run. Visual confirmation of a new outgoing message is required before `PUBLISHED`; external ID may remain null.

After the first confirmed send, only that channel pauses for human review. If a click occurred but confirmation is inconclusive, the Publication becomes terminal with `deliveryUncertain=true`; automatic retry is blocked and `/publicacoes` warns that the message may already have been sent. An authenticated operator may confirm delivered, confirm not delivered or keep the result inconclusive. Only after a separate not-delivered resolution can a second explicit action authorize one retry.

Redis is mandatory and the profile lock uses an ownership token, TTL renewal and ownership-checked release. Browser absence, Redis absence or an occupied profile does not stop Telegram, discovery, the shared worker or assisted mode. UI selector changes can interrupt the experiment; selector mismatch causes a safe group-only pause instead of approximate clicks.
