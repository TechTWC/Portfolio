# Portfolio Analyzer Cloud

Cloud-first personal portfolio analytics project using React, TypeScript, Cloudflare Workers and D1.

## Current vertical slice

- Upload a transaction CSV once.
- Store the canonical ACTIVE dataset in Cloudflare D1.
- Restore the same dataset from another browser after signing in through Cloudflare Access.
- Protect updates with a cloud revision to prevent stale browsers from overwriting newer data.
- Keep archived dataset versions instead of deleting the previous ACTIVE version first.

## Stack

- React + Vite + TypeScript
- Cloudflare Worker + Hono
- Cloudflare D1
- Cloudflare Access identity header

## Local setup

```bash
npm install
npx wrangler d1 migrations apply DB --local
npm run dev
```

For local authentication, configure `AUTH_MODE=dev` and `DEV_USER_EMAIL` in `.dev.vars`. Never enable development auth in production.

## Deployment prerequisites

1. Create a Cloudflare D1 database named `portfolio-analyzer`.
2. Replace `REPLACE_WITH_D1_DATABASE_ID` in `wrangler.jsonc`.
3. Apply the migration remotely.
4. Put the Worker hostname behind Cloudflare Access.
5. Run `npm run build && npx wrangler deploy`.

## Development status

The first pull request establishes the cross-browser cloud persistence layer. The corrected Python portfolio engine and MDD reference engine remain the calculation baseline and will be imported in the next commit series with their regression tests.
