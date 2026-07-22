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

## Manual Offer Flow

Phase 2A supports manual offer ingestion:

1. Open `/ofertas/nova`.
2. Fill the marketplace, product data, prices, coupon and commercial fields.
3. Submit the form.
4. The system calculates the discount internally.
5. `ingestOffer` validates facts, calculates score, persists `OfferScore`, creates an affiliate slug and sets the final status.

Valid offers above the minimum score become `READY_TO_PUBLISH`. Invalid, expired, duplicate or low-score offers are rejected with a deterministic reason.

## Quality Commands

```powershell
npm run lint
npm run typecheck
npm run test
npm run build
```

## Guardrails

- Do not implement authenticated scraping, marketplace login automation, CAPTCHA bypasses or WhatsApp Web automation.
- Keep offer validation and scoring deterministic.
- Store credentials only in environment variables or encrypted server-side database fields.
- Do not expose secrets to client bundles.
