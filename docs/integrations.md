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

- `WhatsAppCloudApiPublisher` for authorized direct messages.
- `WhatsAppGroupsApiPublisher` only if an official Groups API and eligible Business Account capability are available.
- `ManualExportPublisher` as a technical fallback.
- `TelegramPublisher` for automated tests and safe channel validation.

## OpenAI

The AI copywriter uses structured JSON output with `headline`, `body`, `callToAction`, `disclosure` and `hashtags`. Deterministic post-validation rejects inconsistent generated copy.
