# Deployment

## Local

1. Copy `.env.example` to `.env`.
2. Fill `DATABASE_URL`, `AUTH_SECRET`, and admin seed variables.
3. Run `docker compose up -d`.
4. Run `npm install`.
5. Run `npm run prisma:migrate`.
6. Run `npm run db:seed`.
7. Run `npm run dev`.

## Vercel

Deploy `apps/dashboard` to Vercel. Set environment variables in Vercel project settings. Do not expose service-role or marketplace credentials to client-side code.

## Railway

Deploy `apps/worker` to Railway with the same database, Redis and secret environment variables required by automation jobs.

## CI

GitHub Actions runs install, Prisma generation, lint, typecheck and tests on pull requests and pushes to `main`.

## Dependency Audit

Phase 1 runs `npm audit --omit=dev --audit-level=high` as a manual security check. The remaining production audit findings are transitive dependencies inside the current Next.js 15 package (`postcss` and optional `sharp`). Do not run `npm audit fix --force` because the suggested remediation downgrades Next.js and violates the required stack. Recheck this after each Next.js patch upgrade.
