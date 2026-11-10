# Kitan

Kitan is a Telegram group gate. A join request opens a private verification
message; the user completes a Cloudflare Turnstile challenge in a Mini App, and
the request is approved. After entry, the bot watches new members for links,
mass mentions, duplicates, and floods. One Bun process with SQLite: no MongoDB,
Redis, Docker, or OCR.

The verification flow follows the proven Telegram Watchdog pattern. The
risk-control layer is Kitan's own.

## Flow

1. The group uses **Approve new members**.
2. On `chat_join_request`, the bot checks the cross-group blocklist and sends the
   user a private message with a Mini App button.
3. The Mini App verifies the signed Telegram `initData`, the one-time token, and
   Cloudflare Turnstile server-side.
4. On success the bot approves the join request and puts the member on
   **probation**: the first 20 messages / 24 hours are checked for links, mass
   mentions, duplicates, short-message floods, and forwarded media.
5. High-confidence offenses are deleted and muted; three offenses in 30 days
   block the user from auto-approval in every group the bot serves.
6. `/anti_spam` toggles message checks per group.

The verification link expires after 5 minutes. Expired requests are declined
and the user is told to request again. The token is single-use and bound to the
user; the Mini App page and `/api/verify` share one origin.

## Security boundary

Turnstile raises the cost of automation, but it is not a proof of humanity. An
LLM agent with a browser or a CAPTCHA service can pass it. The durable defenses
are post-entry probation, cross-group reputation, rate limits, and admin review.
For a high-value group, use invite-only or manual approval.

## Requirements

- [Bun](https://bun.sh) 1.4+
- A Telegram bot token.
- A group with **Approve new members** enabled.
- The bot as an administrator with:
  - Invite users
  - Delete messages
  - Restrict members
- An HTTPS domain for the Mini App.
- Cloudflare Turnstile keys (required unless `ALLOW_INSECURE=true`).

## Run

```shell
cd server
bun install
cp .env.example .env
# edit .env
bun run dev
```

Production (no runtime dependencies):

```shell
cd server
bun src/index.ts
```

The bot uses long polling and calls `deleteWebhook` at startup. It serves the
Mini App and `/api/verify` on `127.0.0.1:PORT`; put Caddy in front for TLS.

## Commands

| Command | Where | Effect |
|---|---|---|
| `/anti_spam` | group | Toggle message checks (admin only) |
| `/start` | private | Show the invite link |

## Data

SQLite in WAL mode. Message text is not stored; only a content hash for one
hour, member state, settings, per-user offense counts, and pending verification
tokens for five minutes. Updates are kept for seven days for idempotency.

## Development

```shell
cd server
bun run typecheck
bun test
```

## Deploy on a VPS

`server/deploy/` contains a systemd unit and a Caddyfile.

```shell
useradd --system --home /opt/kitan --shell /usr/sbin/nologin kitan
install -d -o kitan -g kitan /var/lib/kitan
cp server/deploy/kitan.service /etc/systemd/system/
cp server/deploy/Caddyfile /etc/caddy/Caddyfile
systemctl enable --now kitan
```

Put the environment in `/etc/kitan.env`, set
`DATABASE_PATH=/var/lib/kitan/kitan.db`, and point `PUBLIC_APP_URL` at the Caddy
domain. The process needs about 40–80 MB RSS; Caddy handles TLS.
