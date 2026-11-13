# Spam benchmark

Scores Kitan's detectors on labelled cases with the production code and the real
Workers AI models.

```shell
CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=$(bunx wrangler auth token) bun bench/run.ts --repeat 3
```

Runs spend the production Worker's Workers AI allowance: 10,000 neurons over a
rolling day on the free plan, which ran out on 2026-11-13 after a day of bench runs
and left production's model calls failing for hours. `budget.ts` makes each run check
what is left (keeping 3,000 for production) and book what it spent in the `spend`
table that production's own budget reads.

## Labels

Each line of `cases.jsonl` is one message from someone who joined less than a day
ago, with two labels, scored separately:

- `message`: `ad` if the message itself advertises or diverts people elsewhere, else `benign`.
- `account`: `spam` if it comes from an advertising account, else `ham`.

They differ because spam accounts often open with a greeting that is harmless on its
own ("大家好，刚加进来打个招呼"). No detector that reads one message can catch those;
catching them takes account-level evidence (who admitted them, edits, leaving right
after posting), which the production footprints now record.

`source` says where a case came from: `incident-YYYY-MM-DD` are real messages from
group screenshots; `synthetic` are hard negatives written to resemble real newcomers.

## Limits

The seed set is small (9 spam, 29 ham) and the ham is synthetic, so it is a smoke
test, not an estimate of production rates. The real benchmark comes from production:
detectors run in shadow on every reviewed message (`events` rows of kind `verdict`),
and are scored against what happened next (banned by an admin, left right after
posting, later listed by lols.bot, or labelled by hand).

## Results, 2026-11-12 (seed set, 3 asks per case)

| detector | message-level precision | recall | false-positive rate |
|---|---|---|---|
| rules (enforced) | 1.00 | 0.50 | 0.00 |
| old keyword lists | 1.00 | 0.25 | 0.00 |
| qwen3-30b, ad ≥ 0.5 | 0.80 | 1.00 | 0.04 |

The model's one false positive is systematic (3 of 3 asks, confidence 0.8): a real
person's complaint, "最近经济不好，工作越来越难找了", read as a covert pitch. This
matches CHASM (NeurIPS 2025), where zero-shot models reach F1 ≈ 0.6 on covert ads
with low precision. The model stays in shadow until production data shows its false
positive rate on real newcomers.

A yes/no decision read from the model's token probabilities (`decideText`) costs
about 0.65 neurons per message against 2.15 for the written verdict, also with
recall 1.00, and one stable false positive: "可以发开源项目链接吗？" (p ≈ 0.82). The
two ask styles misread different ham. (Superseded below: production now runs both
on every distinct message.)

Photos: on three synthetic ad images, llama-4-scout gave the same verdicts (9 of 9)
from Telegram's 320 px size as from 1280 px, at 13–17 neurons instead of 69–105,
though its transcripts lose small print. Production reads the 320 px size.

The first run also caught a false positive in an enforced rule: a person asking
"这个 bot 是群主的吗 @SmartVerifyBot" was read as bot promotion. The rule now needs
the message to be little more than the handle.

## Replay on production, 2026-11-12

`replay.ts` rebuilds what each reviewed message's sender looked like from the
footprints and asks the models again under different views of it. The data and the
labels stay in `~/.cache/kitan-bench/prod`, outside the repo. 41 accounts from four
hours of footprints were labelled by hand (29 spam, 12 ham; accounts that could not
be told apart, such as silent joiners kicked by other captcha bots, were left out).
An account counts as flagged if any of its first four distinct messages is.

| view shown to the model | decision ≥ 0.8: spam caught | ham flagged | written verdict: spam caught | ham flagged |
|---|---|---|---|---|
| message and display name | 9/29 | 0/12 | 15/29 | 1/12 |
| + username, bio, profile channel | **26/29** | **0/12** | **28/29** | 1/12 |
| + group, how they came in, account age, time since joining, message count | 18/29 | 0/12 | 25/29 | 3/12 |

The bio carries most of it: 17 spam accounts were caught only once it was shown.
They had posted nothing yet, or something harmless or empty ("ok", "1.", a contact
card), while their bio was an invite-link ad. More context
did not help: dropping any one of the extra fields only brought the decision back to
20–22 of 29. Production shows the models the second view (`forModels`).

Wording matters for the decision more than for the written verdict: a longer
decision prompt that named covert-ad cues fell to 20/29 on production and still
missed the seed set's covert pitch, so it was reverted. With the second view, the
seed set's 29 ham (9 of them added with links or business in the bio) gave no false
positive in either model; the decision caught 2 of the 4 ads, the written verdict
all 4. Since the written verdict is the stronger detector and 90% of reviewed
messages were a sender repeating themselves (468 messages, 47 distinct), production
now runs both models on every distinct message and skips repeats.

### Guards: where they point people, and whether they talk with anyone

An ad account has to move people somewhere, so `diversionTargets` lists every place
a sender points: invite links, links, @handles, WeChat or QQ ids, phone numbers,
contact cards, buttons, profile channels, and pointers such as "看我主页" or "私我".
Over all their recorded messages, 26 of the 29 spam accounts point somewhere and 1
of the 12 ham does (a personal channel). The three without a target asked to be
contacted ("欢迎各大老板盘口对接"), wrote a pun for 主页 (since added), or only had
"钱解决一切" in the bio. Requiring a target removed the written verdict's one false
positive and cost four catches:

| detector (model sees the profile and the message) | spam caught | ham flagged |
|---|---|---|
| written verdict | 28/29 | 1/12 |
| target only | 24/29 | 1/12 |
| written verdict and a target | 24/29 | 0/12 |
| decision ≥ 0.8 and a target | 23/29 | 0/12 |

(First four distinct messages per account; contact cards from before message kinds
were recorded count as empty, which is most of the gap to 26.)

Social signals (answers given, answers received, stickers) are recorded from
2026-11-12 on and will be scored once there is history to score.

The one ham the written verdict flags is a member asking for help with a cloud service
they had recommended to a friend, named in the message; with 12 ham accounts, a 0/12 rate still allows a true
rate of up to ~25%, so these numbers are a direction, not a licence to act.
