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

For AI copy generation, set `OPENAI_API_KEY` only in server/worker environments. `OPENAI_MODEL`, `OPENAI_TIMEOUT_MS` and `AI_COPY_ENABLED` are optional controls. If OpenAI is not configured, the worker uses deterministic copy and continues normal scheduling/publication.

## CI

GitHub Actions runs install, Prisma generation, lint, typecheck and tests on pull requests and pushes to `main`.

## Dependency Audit

Phase 1 runs `npm audit --omit=dev --audit-level=high` as a manual security check. The remaining production audit findings are transitive dependencies inside the current Next.js 15 package (`postcss` and optional `sharp`). Do not run `npm audit fix --force` because the suggested remediation downgrades Next.js and violates the required stack. Recheck this after each Next.js patch upgrade.
