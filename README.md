# Affiliate Automation

Affiliate Automation is a monorepo for collecting, validating, scoring, publishing and measuring affiliate offers from officially allowed integrations.

## Local Setup

```powershell
npm install
docker compose up -d
npm run prisma:migrate
npm run db:seed
npm run dev
```

The dashboard runs at `http://localhost:3000`. Use the admin credentials configured by `ADMIN_EMAIL` and `ADMIN_PASSWORD` in `.env`.

Docker Compose starts PostgreSQL and Redis. For local Redis health and worker locks, set:

```env
REDIS_URL="redis://localhost:6379"
APP_BASE_URL="http://localhost:3000"
```

## Manual Offer Flow

Phase 2A supports manual offer ingestion:

1. Open `/ofertas/nova`.
2. Fill the marketplace, product data, prices, coupon and commercial fields.
3. Submit the form.
4. The system calculates the discount internally.
5. `ingestOffer` validates facts, calculates score, persists `OfferScore`, creates an affiliate slug and sets the final status.

Valid offers above the minimum score become `READY_TO_PUBLISH`. Invalid, expired, duplicate or low-score offers are rejected with a deterministic reason.

## Publication Flow

Phase 2B adds click tracking, channel configuration and the worker publication loop:

```text
READY_TO_PUBLISH -> SCHEDULED -> PUBLISHED | EXPORTED | PUBLICATION_FAILED
```

To test Telegram:

1. Create a Telegram bot with BotFather.
2. Add the bot to the target chat.
3. Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in `.env`.
4. Open `/canais` and create a `TELEGRAM` channel.
5. Click `Testar Telegram`.
6. Create a valid offer in `/ofertas/nova`.
7. Run `npm run worker:once`.

The worker creates `Publication`, sends the message, records `PublicationAttempt`, and updates the dashboard with real publication and click data.

Manual export channels create `EXPORTED` publications. They do not count as external publications and do not update the offer as published.

## Tracking

Affiliate links are exposed through `/go/[slug]`. The route records a `Click` with affiliate link, offer, publication when available, channel when available, marketplace, referer and user agent. It never stores raw IP addresses. If tracking fails, the user is still redirected with a temporary HTTP redirect.

To test tracking manually, open the generated tracking URL shown in the publication message or visit `/go/{slug}` for an active `AffiliateLink`.

## Worker Commands

```powershell
npm run worker:once
npm run worker:dev
npm run worker:start
```

`worker:once` runs one cycle. `worker:dev` and `worker:start` poll continuously using `WORKER_POLL_INTERVAL_MS`, defaulting to 60000 ms.

## Quality Commands

```powershell
npm run lint
npm run typecheck
npm run test
npm run build
npx prisma migrate status --schema prisma/schema.prisma
```

## Guardrails

- Do not implement authenticated scraping, marketplace login automation, CAPTCHA bypasses or WhatsApp Web automation.
- Keep offer validation and scoring deterministic.
- Store credentials only in environment variables or encrypted server-side database fields.
- Do not expose secrets to client bundles.
