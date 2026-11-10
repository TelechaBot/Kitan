# Kitan

Kitan is a Telegram join-request gate on one Cloudflare Worker: a webhook, a
Mini App page with a Cloudflare Turnstile check, and a D1 table that records
every attempt.

## Flow

- **Guard bot** (Bot API 10.1): when the bot is the chat's guard bot, the join
  request carries `query_id`. The Worker calls `sendChatJoinRequestWebApp`, so
  Telegram opens the check directly. Success answers `approve`; a failed launch
  answers `queue` (admins decide); no answer within 10 minutes answers `decline`.
- **DM fallback**: without `query_id`, the bot messages the requester a Mini App
  button. No answer within 5 minutes declines the request.

The Mini App and the DM follow the requester's Telegram language (en, zh,
zh-Hant, ja, ru, es, ar, hi, bn).

The group needs **Approve new members**; the bot needs admin rights to invite
users and to see member updates (used for the outcome labels below).

## Security boundary

Turnstile raises the cost of automation; it does not prove a human. Commercial
solver services return accepted Turnstile tokens in 4–14 seconds (Akamai,
*Broken Gates*, arXiv 2607.18659). Treat the gate as a cost, and keep admin
review for high-value groups.

## Deploy

```shell
bun install
bunx wrangler d1 migrations apply kitan --remote
bunx wrangler secret put TELEGRAM_BOT_TOKEN   # also TURNSTILE_SITE_KEY, TURNSTILE_SECRET_KEY, WEBHOOK_SECRET
bunx wrangler deploy
curl -X POST https://<host>/setup -H "x-setup-key: $WEBHOOK_SECRET"
```

The Worker is served only on a custom domain attached in Cloudflare (workers.dev
is off). The Turnstile widget's hostname must match that domain; `/api/verify`
rejects tokens issued for any other host. `/setup` registers the webhook and
reports `supports_join_request_queries`. A webhook excludes `getUpdates`, so no
long-polling bot may run with the same token.

## Measurement

`attempts` keeps, per join request: delivery path, Mini App open time, tries,
client-reported Turnstile solve time, Turnstile error, Telegram error, decision,
and two labels from `chat_member` updates: `left_at` and `banned_at` after
approval.

```shell
bunx wrangler d1 execute kitan --remote --command \
  "SELECT delivery, status, count(*) n, sum(opened_at IS NULL) never_opened, sum(banned_at IS NOT NULL) banned FROM attempts GROUP BY 1, 2"
```

## Check

```shell
bun run check   # tsc + bun test
```
