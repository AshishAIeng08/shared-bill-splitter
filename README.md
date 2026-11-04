# Common · Shared Expense Manager

Common is a multi-user expense sharing app built with React, TypeScript, Hono, Cloudflare Workers, and D1. It supports individual accounts, email verification, shared groups, email invitations, split expenses, balances, settlement records, in-app notifications, and activity history.

## Run locally

Requirements: Node.js and pnpm.

```sh
pnpm install
pnpm dev
```

The web app runs at <http://localhost:5173> and the API at <http://localhost:8787>. Vite proxies `/api` to the local Worker.

## Email delivery setup

Email verification, password resets, group invitations, expense alerts, and settlement confirmations use [Resend](https://resend.com/). Create a Resend API key and verify a sender domain, then set these Worker secrets:

```sh
cd api
pnpm exec wrangler secret put RESEND_API_KEY
pnpm exec wrangler secret put EMAIL_FROM
pnpm exec wrangler secret put APP_URL
```

`EMAIL_FROM` must be a verified Resend sender, for example `Common <updates@example.com>`. `APP_URL` is the public app origin and should not include a trailing slash. Never commit credentials. Without email secrets, registration remains unverified, password reset and invite emails are not sent, and the UI reports that email delivery needs configuration.

## Database

Cloudflare D1 migrations live in `api/migrations`. The production D1 database is provisioned and its schema applied with:

```sh
cd api
pnpm exec wrangler d1 migrations apply shared-bill-splitter --remote
```

Local development and tests use Wrangler's local D1 database.

## Checks

```sh
pnpm check
pnpm typecheck
pnpm test
pnpm build
```

## Security notes

- Passwords are stored as salted PBKDF2-SHA-256 hashes; session and one-time token values are random and only their SHA-256 hashes are stored.
- Sessions use `HttpOnly`, `Secure`, and `SameSite=Strict` cookies. Private routes enforce verified identity and group membership on the Worker.
- Expense amounts use integer paise. Percentage and share splits distribute remainder paise deterministically; exact splits must add to the bill total.
- Expense actions and email sends are recorded in the database. Email delivery uses recipient addresses loaded from registered accounts, not user-entered names.

## Current deployment

The live Worker URL is <https://shared-bill-splitter-api.ashish1053singh.workers.dev>. Configure the email secrets above on the Cloudflare Worker before inviting real users to register.
