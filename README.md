# Common · Shared Bill Splitter

A small household bill splitter built with Hono on Cloudflare Workers, D1, React, Vite, TanStack Router, and TypeScript.

## Run locally

Requirements: Node.js and pnpm.

```sh
pnpm install
pnpm dev
```

The web app runs at <http://localhost:5173> and the API at <http://localhost:8787>. Wrangler applies the D1 migrations to its local database. Run `pnpm check`, `pnpm typecheck`, `pnpm test`, and `pnpm build` from the root to check the project.

## API

- `POST /api/homes` creates a home.
- `POST /api/homes/:homeId/members` adds a member.
- `POST /api/homes/:homeId/bills` splits a positive integer cent amount in member signup order.
- `POST /api/bills/:billId/shares/:shareId/pay` settles a share with an `Idempotency-Key` header.
- `GET /api/homes/:homeId/bills` lists bills and shares for the web page.
- `GET /api/homes/:homeId/balances` lists outstanding integer-cent balances in member order.

## Decisions

1. **Store money as integer cents.** This avoids floating point rounding; the remainder is assigned one cent at a time in member creation order.
2. **Protect relationships and values in SQLite.** Foreign keys, unique keys, and `CHECK` constraints keep invalid data out even if a future API path is added.
3. **Claim a payment with one conditional update.** `UPDATE ... WHERE paid_at IS NULL` makes concurrent payment attempts race safely; the idempotency key lets a retry return the original payment result.

## Assignment walkthrough

The browser calls the Hono API through Vite's `/api` proxy. The API validates input, writes the bill and all shares in one D1 batch, and uses a guarded update for payment. The UI retains the unpaid state until the server confirms success; transport and API errors show an alert while the existing bill stays visible.

**AI assistance:** OpenAI Codex was used to draft and refine this project. I reviewed the implementation and should be ready to explain its validation, schema constraints, split calculation, and payment flow in the walkthrough video.

**Walkthrough video:** Add a public, viewable video link here before submitting the application.
