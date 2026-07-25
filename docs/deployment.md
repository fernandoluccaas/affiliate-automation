# Deployment

## Local

1. Copy `.env.example` to `.env`.
2. Fill `DATABASE_URL`, `AUTH_SECRET`, and admin seed variables.
3. Set `REDIS_URL="redis://localhost:6379"` for local Redis locks.
4. Run `docker compose up -d`.
5. Run `npm install`.
6. Run `npm run prisma:migrate`.
7. Run `npm run db:seed`.
8. Run `npm run dev`.
9. Run `npm run worker:once` for one publication cycle or `npm run worker:dev` for polling.

To test tracking, open a generated `/go/[slug]` URL and confirm the dashboard click count changes.

## Vercel

Deploy `apps/dashboard` to Vercel. Set environment variables in Vercel project settings. Do not expose service-role or marketplace credentials to client-side code.

## Railway

Deploy `apps/worker` to Railway with the same database, Redis and secret environment variables required by automation jobs.

Set `APP_BASE_URL` to the dashboard URL so worker-generated tracking links point to production. Set `WORKER_POLL_INTERVAL_MS` and `WORKER_MAX_ATTEMPTS` as needed. For Telegram publication, set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.

For AI copy generation, Ollama is the default local provider:

```env
AI_PROVIDER="ollama"
OLLAMA_BASE_URL="http://localhost:11434"
OLLAMA_MODEL="qwen3:4b"
AI_COPY_ENABLED="true"
AI_COPY_TIMEOUT_MS="30000"
```

Install the model on machines that run the worker:

```powershell
ollama pull qwen3:4b
ollama run qwen3:4b
```

The worker calls Ollama over HTTP and falls back to deterministic copy if Ollama is unavailable. Local Ollama execution has no token billing. For OpenAI, set `AI_PROVIDER="openai"` and configure `OPENAI_API_KEY` only in server/worker environments.

For Mercado Livre, configure the application credentials in the dashboard and worker environments:

```env
MERCADO_LIVRE_CLIENT_ID=""
MERCADO_LIVRE_CLIENT_SECRET=""
MERCADO_LIVRE_REDIRECT_URI="https://your-dashboard.example.com/api/integrations/mercadolivre/callback"
MERCADO_LIVRE_SITE_ID="MLB"
```

Keep `APP_BASE_URL` aligned with the dashboard URL. Run `npm run prisma:migrate` after deploying migration `20260725110000_phase_3a_mercado_livre`. Connect the account from `/integracoes`, then configure categories and discovery filters in `/integracoes/mercado-livre`. The worker uses Redis locks for token refresh and discovery/publication coordination.

## CI

GitHub Actions runs install, Prisma generation, lint, typecheck and tests on pull requests and pushes to `main`.

## Dependency Audit

Phase 1 runs `npm audit --omit=dev --audit-level=high` as a manual security check. The remaining production audit findings are transitive dependencies inside the current Next.js 15 package (`postcss` and optional `sharp`). Do not run `npm audit fix --force` because the suggested remediation downgrades Next.js and violates the required stack. Recheck this after each Next.js patch upgrade.
