# Kitan

Kitan checks people who ask to join your Telegram group. Each person completes
a short Cloudflare check before the bot lets them in.

## Use it in your group

1. In the group settings, turn on **Approve new members**.
2. [Add @SmartVerifyBot to your group](https://t.me/SmartVerifyBot?startgroup&admin=can_invite_users+can_delete_messages+can_restrict_members)
   as an admin with three permissions: **Invite users**, **Delete messages**,
   and **Ban users**. Without the last two, the bot can check people but cannot
   remove spam after they join.

When someone asks to join, the bot sends them a private message with a
**Verify** button. They have 5 minutes to finish the check. If they pass, the
bot approves the request. If they do nothing, the bot declines it, and they can
ask to join again.

The message and the check page use the person's Telegram language: English,
Simplified Chinese, Traditional Chinese, Japanese, Russian, Spanish, Arabic,
Hindi, or Bengali.

## How Kitan stops spam accounts

The check alone stops simple bots, but not organised spam: paid solving
services pass Cloudflare's check in 4 to 14 seconds
([Akamai, 2026](https://arxiv.org/abs/2607.18659)). What costs spammers money
is the account itself, about US$0.89 each
([Cambridge COTSI, 2025](https://www.cam.ac.uk/stories/price-bot-army-global-index)),
so Kitan makes each spam attempt cost an account:

- **Before the check**, Kitan declines accounts listed by
  [lols.bot](https://lols.bot) and accounts it has blocked itself.
- **For 24 hours after joining** (or the first 20 messages), Kitan watches new
  members. A message with a link, four or more @mentions, a forward, or an
  inline-bot button is deleted, and the sender is muted until the 24 hours end.
- **A second offence within 30 days, in any group that uses Kitan**, or the
  same text posted in two groups, bans the account from every group where it
  is still new and blocks it from joining any Kitan group.

Members who joined before Kitan, or more than 24 hours ago, are never checked.
If Kitan removes someone by mistake, unban them in the group settings.

## Run your own copy

You need a Cloudflare account, a domain on Cloudflare, and a bot token from
[@BotFather](https://t.me/BotFather).

1. Install and create the database:
   ```shell
   bun install
   bunx wrangler d1 create kitan        # put the printed database_id in wrangler.jsonc
   bunx wrangler d1 migrations apply kitan --remote
   ```
2. Create a Turnstile widget for your domain, then store four secrets:
   ```shell
   bunx wrangler secret put TELEGRAM_BOT_TOKEN
   bunx wrangler secret put TURNSTILE_SITE_KEY
   bunx wrangler secret put TURNSTILE_SECRET_KEY
   bunx wrangler secret put WEBHOOK_SECRET    # any random string of letters and digits
   ```
3. Deploy, attach your domain to the Worker in the Cloudflare dashboard, and
   connect the bot:
   ```shell
   bunx wrangler deploy
   curl -X POST https://<your-domain>/setup -H "x-setup-key: <WEBHOOK_SECRET>"
   ```
   The reply shows the bot name and whether the bot can act as a guard bot.

Do not run another program with the same bot token: Telegram sends updates to
only one place.

Run the tests with `bun run check`.

### Guard bot mode

If Telegram lets your bot act as a group's guard bot (Bot API 10.1), the check
opens as soon as someone asks to join, without a private message, and the
person has 10 minutes. Kitan uses this mode automatically when Telegram enables
it; otherwise it uses private messages.

## Data Kitan keeps

For each join request, Kitan stores the group, the user ID, which way the check
was delivered, when the page was opened, how many tries it took, how long the
check took, any error, and the result. If an approved member later leaves or is
banned, Kitan records the time. During the first 24 hours it also keeps a hash
of each message for 10 minutes and a record of each offence for 30 days. It
stores no message text.

To check the shared spam list, Kitan sends the requester's Telegram user ID to
lols.bot. To see a summary:

```shell
bunx wrangler d1 execute kitan --remote --command \
  "SELECT delivery, status, count(*) FROM attempts GROUP BY 1, 2"
```
