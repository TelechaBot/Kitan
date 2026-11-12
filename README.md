# Kitan

Kitan checks people who ask to join your Telegram group. Each person completes
a short Cloudflare check before the bot lets them in.

## Use it in your group

1. In the group settings, turn on **Approve new members**.
2. [Add @SmartVerifyBot to your group](https://t.me/SmartVerifyBot?startgroup&admin=can_invite_users+can_delete_messages+can_restrict_members)
   as an admin with three permissions: **Invite users**, **Delete messages**,
   and **Ban users**. Without the last two, the bot can check people but cannot
   remove spam after they join.

3. If your Telegram app lets you pick a **guard bot** for join requests in the
   group settings, pick @SmartVerifyBot. Telegram then opens the check for
   people as soon as they ask to join, so nobody depends on a private message.
   Use only one bot to screen join requests: if another bot messages someone
   first, Telegram stops Kitan from messaging them.

When someone asks to join, the bot sends them a private message with a
**Verify** button. They have 5 minutes to finish the check. If they pass, the
bot approves the request. If they do nothing, the bot declines it, and they can
ask to join again. Each time they come back within a week they get three times
as long (15 minutes, then 45, up to 6 hours), so someone who missed the message
is not hurried, while bulk accounts, which rarely ask twice, keep the short
limit.

### If someone gets no message

Telegram does not let bots write first to some people, usually because of
their privacy settings. If the person opens @SmartVerifyBot and presses
**Start** within an hour, the check arrives straight away. Otherwise Kitan
declines the request after the hour, so they can ask to join again; a request
nobody answers would stop them from asking again. A person who comes back gets
longer each time (3 hours, then 9, up to a day). You can still approve or
decline the request yourself while it waits.

### Requests from before Kitan

Kitan can only answer requests it received. Requests left from before Kitan
was added, or from while it was offline, stay in the group's **Join requests**
list, and those people cannot ask again until someone answers. Telegram only
lets a person, not a bot, list them, so an admin can clear them in one go with
their own account:

```shell
TG_API_ID=… TG_API_HASH=… bun scripts/clear-stale-requests.ts --before <when Kitan started>
```

Get the API id and hash at [my.telegram.org](https://my.telegram.org) under
**API development tools**. The script lists, for each group you admin, how many
requests are older than `--before`; add `--apply` to decline them. Declined
people can ask to join again right away, and Kitan will check them.

To tell people this, add a line like this to your group description:

> Asked to join but heard nothing? Open @SmartVerifyBot and press Start.

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
- **For 7 days after joining**, Kitan reviews every message from a new member,
  however many they post, whoever let them in: Kitan, another bot, an admin or
  an invite link. After that, Kitan keeps reviewing an account until it has
  sent more than 20 messages across Kitan groups. Edited messages are checked
  again, since spam accounts often post a greeting and edit it into an ad. A
  message with a link, four or more @mentions, a forward, an inline-bot
  button, or little more than a bot's @handle is deleted, and the sender is
  muted for 24 hours. So is the fourth copy of the same text or contact card
  within 15 minutes in one group.
- **Active members are left alone**, whatever they post, unless their activity
  stops looking like the people in Kitan's groups: a model retrained daily on
  active members' activity (how often and when they post, how much of it is
  links, mentions or forwards, and how that has recently changed) flags the
  account, and Kitan reviews it again. Members who were in a group before
  Kitan and spoke in its first week count as active.
- **A second offence within 30 days, in any group that uses Kitan**, or the
  same text posted in two groups, bans the account from every group where it
  is still new and blocks it from joining any Kitan group.
- **Anyone who is not an admin** loses a message that carries a link button.
  A bot or a channel posting one is banned from the group; a member is banned
  on the second time.

Language and image models also read the name, username, bio and profile
channel of each member under review, with each new message (and the preview of
a photo or video), but only to record what they would have done: they do not
act until their false positives on real newcomers are measured (see `bench/`). If Kitan removes
someone by mistake, unban them in the group settings.

Use only one bot to screen a group's join requests. A person another bot lets
in skips Kitan's check, so only the message review applies to them.

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
   The reply shows the bot name, whether the bot can act as a guard bot, and,
   for each group the bot has seen, its guard bot and whether Kitan can delete
   messages and ban users there. To see that report again later, send the same
   request to `/status`.

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
banned, Kitan records the time.

For each account, Kitan keeps a summary of its activity across Kitan groups:
counts and averages of when and how often it posts and what share of its
messages carry links, mentions, forwards or media, but no message text. It
also notes which groups it has spoken or joined in, and when it joined. For
each group, Kitan keeps its title, public handle and when it was last seen.

For members under review, Kitan keeps their profile: name, username, bio,
profile channel, whether they have a photo or Premium, and their language,
read from Telegram when they join or are first reviewed and again after a week.
It also keeps a record for 14 days so an incident can be traced afterwards: how
they joined and who let them in, the first 500 characters of each message and
edit, what kind of message it was, the name on a shared contact card (not its
phone number), and what each check concluded and did. It also keeps a hash of
each message for 15 minutes and each offence for 30 days. Messages from active
members are not stored.

To check the shared spam list, Kitan sends the requester's Telegram user ID to
lols.bot. The names, bios, messages and photos of members under review are sent
to Cloudflare Workers AI for the model checks. To see a summary, or one person's trail:

```shell
bunx wrangler d1 execute kitan --remote --command \
  "SELECT delivery, status, count(*) FROM attempts GROUP BY 1, 2"
bunx wrangler d1 execute kitan --remote --command \
  "SELECT datetime(at/1000,'unixepoch'), kind, detail FROM events WHERE user_id = '<id>' ORDER BY at"
```
