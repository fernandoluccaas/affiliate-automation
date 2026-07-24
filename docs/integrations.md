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

## AI Copywriter

The AI copywriter is multi-provider. Ollama is the default local provider and OpenAI is optional.

### Ollama

Configure Ollama for local generation:

```env
AI_PROVIDER="ollama"
OLLAMA_BASE_URL="http://localhost:11434"
OLLAMA_MODEL="qwen3:4b"
AI_COPY_ENABLED="true"
AI_COPY_TIMEOUT_MS="30000"
```

Prepare the default model:

```powershell
ollama pull qwen3:4b
ollama run qwen3:4b
```

The application calls the local Ollama HTTP API at `OLLAMA_BASE_URL` and uses `/api/generate` with `stream: false` and a JSON schema in `format`. It never executes the `ollama` binary or controls a terminal. Running models locally does not create token billing, although local hardware and any cloud infrastructure still have their own costs.

`/integracoes` shows whether Ollama is configured, whether the HTTP service is available, the sanitized base URL, selected model and status. Ollama offline is treated as an integration status, not as an application health failure.

### OpenAI

OpenAI remains available only when explicitly selected:

```env
AI_PROVIDER="openai"
OPENAI_API_KEY=""
OPENAI_MODEL="gpt-4.1-mini"
AI_COPY_TIMEOUT_MS="30000"
```

When `AI_PROVIDER="ollama"`, no OpenAI key is required and no OpenAI provider is selected.

### Structured Copy

Both providers use structured JSON output:

- `headline`
- `body`
- `callToAction`
- `disclosure`
- `hashtags`

The worker sends only confirmed offer facts and the generated tracking URL. Deterministic post-validation rejects inconsistent prices, discounts, coupon claims, free-shipping claims, missing affiliate disclosure, extra URLs and unsupported urgency. Any failure uses the deterministic composer and records `DETERMINISTIC_FALLBACK` on `Publication`.

`/integracoes` can test Ollama or OpenAI server-side without publishing a message. Secrets are never returned to the browser.
