# Integrations

## Marketplaces

Shopee and Mercado Livre connectors must use officially permitted APIs, exports or partner mechanisms. The system must not automate marketplace logins, bypass CAPTCHA or perform authenticated scraping without express authorization.

## Publishers

The publication layer uses a `PublisherAdapter` contract with:

- `validateCredentials`
- `publish`
- `getPublicationStatus`
- `retry`
- `healthCheck`

Prepared adapters:

- `TelegramPublisher` uses the official Telegram Bot API. It sends an image when `imageUrl` is valid and falls back to text when image delivery fails.
- `ManualExportPublisher` stores the generated message as `EXPORTED` and never marks it as an external publication.
- WhatsApp Cloud API and WhatsApp Groups API appear as unavailable channel types in Phase 2B. They do not simulate publication.

## Telegram Setup

Set these variables on the server:

```env
TELEGRAM_BOT_TOKEN=""
TELEGRAM_CHAT_ID=""
```

Then create a `TELEGRAM` channel in `/canais` and use `Testar Telegram`. The bot token is never stored in client-visible code or logs. Telegram responses are sanitized to keep only status, description and message ID.

## Redis

Production uses Upstash Redis:

```env
UPSTASH_REDIS_REST_URL=""
UPSTASH_REDIS_REST_TOKEN=""
```

Local development uses the Redis container from Docker Compose:

```env
REDIS_URL="redis://localhost:6379"
```

`/api/health` pings whichever Redis configuration is active. When neither is configured, Redis is reported as unavailable without breaking the dashboard.

## OpenAI

The AI copywriter uses the official OpenAI SDK and the Responses API with structured JSON output:

- `headline`
- `body`
- `callToAction`
- `disclosure`
- `hashtags`

Configure only server-side variables:

```env
OPENAI_API_KEY=""
OPENAI_MODEL="gpt-4.1-mini"
OPENAI_TIMEOUT_MS="8000"
AI_COPY_ENABLED="true"
```

The worker sends only confirmed offer facts and the generated tracking URL. Deterministic post-validation rejects inconsistent prices, discounts, coupon claims, free-shipping claims, missing affiliate disclosure, extra URLs and unsupported urgency. Any failure uses the deterministic composer and records `DETERMINISTIC_FALLBACK` on `Publication`.

`/integracoes` shows whether OpenAI is configured and enabled without exposing the key. `Testar copy` runs a server-side dry test and does not publish a message.
