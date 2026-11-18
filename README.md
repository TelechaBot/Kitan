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
limit. Most people see one Cloudflare check; a profile that looks like an ad
is turned away once with the reason, and gets two checks and a simple sum if
it asks again (see below).

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
  [lols.bot](https://lols.bot) and accounts it has blocked itself. Everyone
  else's profile is audited after the webhook has answered (up to 20 seconds
  per model): the keyword list (`bannedWords`) on the name, username, bio and
  channel, a Workers AI text model when they point somewhere, and an image
  model on the avatar. The audit ends in one of three answers:
  - **ad** — a keyword match, a confident text verdict (decision ≥ 0.9 and
    written verdict at confidence ≥ 0.85) or a confident avatar verdict
    (≥ 0.9). The request is declined, and the person is told why in a private
    message and that asking again gets a longer check. Asking again within a
    week gets the **strict check: two Cloudflare Turnstile checks and one
    simple sum, in a shuffled order**. A wrong sum gets a fresh question; only
    the current step is ever checked, so a token spent on an earlier one is no
    use.
  - **unknown** — a model the profile needed did not answer (error, timeout,
    or the day's model budget is spent). The strict check: an unread profile
    is not a clean one.
  - **clean** — the ordinary single Turnstile check.
- **People who join directly** (an open group, an invite link, another bot's
  check) never meet the door, so Kitan audits their profile when they join, with
  the keyword list and the text model (not the avatar, for the budget). An ad
  profile is removed from the group without a ban; joining again within a week
  keeps them muted for up to a week, with a private notice whose button opens
  the strict check, and passing it lifts the mute. People Kitan admitted were
  audited at the door, and people an admin added or approved are left alone.
- **Inside a group**, Kitan reviews only non-admin members with **fewer than
  seven clean messages in the last seven days in that group**. A message counts
  only when Kitan did not delete it, and an edited message never counts, so
  spam cannot buy its way out. Once a member reaches seven clean messages
  there, Kitan leaves them alone completely: no rule, no model, no footprint.
  Rejoining the group resets the count, and the clock is per group.
- The rules are the Python bot's smallest set. A message is deleted when it:
  - carries a Telegram or WhatsApp link (`t.me/`, `telegram.me/`, `tg://`,
    `wa.me/`) in its text or a link entity, or a link entity carrying
    `?start=`, `?aff=` or `/startapp`;
  - has four or more @mentions;
  - is little more than a bot's @handle (a slash command naming a bot, or a
    handle inside a sentence, is not);
  - carries an inline link button;
  - contains a word from the earlier Kitan's ad list (not words people use in
    ordinary talk), or nothing but an offer such as "可约";
  - is the fourth copy of the same text or contact card within 15 minutes in
    one group, or the same text posted in two groups.

  Ordinary web links — video, art, code, papers, news, personal sites — and
  plain forwards are conversation, not advertisements. How long the sender is
  muted depends on the evidence, since no rule is certain:

  | evidence | points |
  |---|---|
  | a Telegram/WhatsApp or tagged link | 1 |
  | four @mentions, a link button, or a listed word | 2 |
  | little more than a bot's @handle, or a flood | 3 |
  | the name, bio or a shared contact card points people somewhere | +2 |
  | someone in Kitan's groups has talked with them | −1 |
  | each earlier offence in the last 30 days | +2 |

  1 point mutes for 3 minutes, 2 for an hour, 3 for 6 hours, 4 for a day.
  5 or more bans the account from every group where it is still new, removes
  its messages there, and blocks it from joining any Kitan group for 30 days.
  A newcomer's first diversion link costs 3 minutes; a flood from an account
  whose bio is an invite link is a ban. A muted member is told privately why
  and until when, with a button that opens the bot and offers the same check
  as at the door; passing it lifts the mute at once. This works once per
  account in 30 days, and the offence still counts towards the next penalty.
  A ban has no such way back; a group admin can lift one in the group settings.
- **Group admins are never moderated**: their messages still feed the
  behaviour sketch and their clean messages still count towards probation,
  but no rule, model or footprint acts on them.
- **The same text posted in two groups** within 15 minutes is a ban outright.
- **Anyone under review** who sends a message with a link button loses it. A
  bot or a channel posting one is banned from the group.

Language and image models also read the name, username, bio and profile
channel of each member under review (fewer than seven clean messages in seven
days), with each new message and photo/video preview. When guarded against
ordinary chat (a strong diversion target for text, or visible ad text /
diversion target for images) and both confident (decision ≥ 0.9 with written
verdict confidence ≥ 0.85, or image confidence ≥ 0.9), the model deletes the
message and applies the same graduated penalty — and deleted messages never
count towards the seven clean messages. Ordinary images without visible ads
are left alone. The models are asked only where their answer could matter:
within 7,000 neurons a day (below Workers AI's free 10,000), skipping members
who have already exchanged replies or stickers. Past the daily budget, the
deterministic rules keep working and the models wait. If Kitan removes
someone by mistake, unban them in the group settings.

Use only one bot to screen a group's join requests. A person another bot lets
in skips Kitan's check, so only the message review applies to them. So does
anyone who joins through an invite link that doesn't require approval, by
design. If such a link brings in mostly ad accounts (at least 10 in a week,
and at least half of those who used it), Kitan tells the group owner once,
privately, and does not mention that link again for 30 days.

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
check took, any error, the result, and — for a strict check — which steps it
had and how far the person got. If an approved member later leaves or is
banned, Kitan records the time. For each mute it keeps, for 30 days, which rule
and score caused it, and whether and how fast the member passed the check to
lift it.

For each account, Kitan keeps a summary of its activity across Kitan groups:
counts and averages of when and how often it posts and what share of its
messages carry links, mentions, forwards or media, and how many of its messages
answered someone, were answered, or were stickers, but no message text. It
also notes which groups it has spoken or joined in, when it joined, and the
times of its clean messages that count towards probation there (at most seven
per group, and one write per six hours once probation has ended). For each
group, Kitan keeps its title, public handle and when it was last seen.

For people who ask to join and for members under review, Kitan keeps their
profile: name, username, bio, profile channel, whether they have a photo or
Premium, and their language, read from Telegram when they ask to join, when
they join, or at first review, and again after a week. It also keeps a record
for 14 days so an incident can be traced afterwards: how they joined and who
let them in, the first 500 characters of each message and edit, what kind of
message it was, the name on a shared contact card (not its phone number), and
what each check concluded and did. It also keeps a hash of each message for 15
minutes and each offence for 30 days. Messages from members past probation are
not stored.

To check the shared spam list, Kitan sends the requester's Telegram user ID to
lols.bot. The names, bios and profile channels of join requesters whose
profile points somewhere, and the names, bios, messages and photos of members
under review, are sent to Cloudflare Workers AI for the model checks. To see a summary, or one person's trail:

```shell
bunx wrangler d1 execute kitan --remote --command \
  "SELECT delivery, status, count(*) FROM attempts GROUP BY 1, 2"
bunx wrangler d1 execute kitan --remote --command \
  "SELECT datetime(at/1000,'unixepoch'), kind, detail FROM events WHERE user_id = '<id>' ORDER BY at"
```
