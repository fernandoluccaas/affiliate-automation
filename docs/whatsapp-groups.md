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
```

Profiles and debug output are Git-ignored. `webProfileKey` accepts only ASCII letters, digits, hyphen and underscore and is resolved below the configured root. Do not point it at or copy a personal browser profile.

### Local commands

```bash
npm run whatsapp:web:install-browser
npm run whatsapp:web:login -- --profile principal
npm run whatsapp:web:health -- --profile principal
npm run whatsapp:web:locate -- --channel-id <CHANNEL_ID>
npm run whatsapp:web:dry-run -- --publication-id <PUBLICATION_ID>
npm run whatsapp:web:publish -- --publication-id <PUBLICATION_ID> --confirm-send
```

Login opens visible Chromium and waits for manual QR interaction without capturing it. Health detects authenticated UI, not HTTP 200. Locate uses the persisted `groupDisplayName`, whitespace-only normalization, exact matching, opened-title verification and composer permission; it never accepts a CLI group-name override or chooses the first ambiguous result.

Dry-run requires the feature flag, ownership confirmation, connected session, Redis, exact group and `WEB_EXPERIMENTAL`. It prepares the safe image or configured text fallback, fills the immutable Publication snapshot, checks the unique title snippet and affiliate URL, does not invoke send, clears the draft and persists a configuration fingerprint. A change to channel ID, group name, profile key, mode or `sendImage` invalidates that fingerprint.

Real send is compiled but not executed by tests. It additionally requires `WHATSAPP_WEB_DRY_RUN=false`, `--confirm-send`, enabled/unpaused channel, current successful dry-run fingerprint and all shared scheduling policies. At most one Web Publication is processed per run. Visual confirmation of a new outgoing message is required before `PUBLISHED`; external ID may remain null.

After the first confirmed send, only that channel pauses for human review. If a click occurred but confirmation is inconclusive, the Publication becomes terminal with `deliveryUncertain=true`; automatic retry is blocked and `/publicacoes` warns that the message may already have been sent. An authenticated operator may mark delivered/not delivered, cancel retry or explicitly authorize one retry.

Redis is mandatory and the profile lock uses an ownership token, TTL renewal and ownership-checked release. Browser absence, Redis absence or an occupied profile does not stop Telegram, discovery, the shared worker or assisted mode. UI selector changes can interrupt the experiment; selector mismatch causes a safe group-only pause instead of approximate clicks.
