# Door benchmark and baseline

What Kitan is measured against when it decides who gets into a group. `door.ts` builds
the cases and scores every policy on them; this file records the numbers and the rules
for reading them. The cases are real people's profiles, so they stay outside the repo
(`~/.cache/kitan-bench/prod`); only aggregates are written here.

```shell
bun bench/replay.ts export ~/.cache/kitan-bench/prod   # D1 → jsonl
bun bench/door.ts cases                                # freeze the labelled cases
bun bench/door.ts score                                # the tables below
bun bench/door.ts live 24                              # the same doors in production, last 24 h
```

## What is measured

A **case** is one way into one group: a join request, or a direct join (open group, invite
link, another bot's check). Kitan's own approvals and people an admin added are not cases.
Each policy sees only what Kitan saw then, including the model answers it actually got.

| outcome | request door | direct door |
|---|---|---|
| turned away | declined, told why | muted, told why, removed a minute later |
| challenged | strict check (two Turnstile, one sum) | held: muted, strict check, removed after 10 min |
| allowed | ordinary check | nothing |

**Labels** never come from the policies being scored:

| label | source |
|---|---|
| spam | hand label; listed on lols.bot; removed by a human admin afterwards; banned by Kitan's message rules (several ads) |
| ham | hand label; replied to someone or was replied to, with no spam signal |

Requests declined before any audit (lols.bot, Kitan's blocklist) are the same under every
policy and are left out.

**Metrics**: for spam, the share turned away and the share turned away or challenged
("stopped"); for ham, the share turned away (the false-positive rate) and the share
challenged (friction). Intervals are 95% Wilson. Two policies are compared on the same
cases with the exact McNemar test on the spam where they disagree.

## Baseline: commit 249e6c2 vs current, 2026-11-12 – 2026-11-18

424 requests declined before the audit (lols.bot, blocklist) are left out: every policy here declines them.

### Join requests: 4735 cases; spam 39 (lols 29, admin 10); ham 27 (hand 9, talked 18)

| policy | spam turned away | spam turned away or challenged | ham turned away | ham challenged |
|---|---|---|---|---|
| baseline 249e6c2 | 0.0% [0.0–9.0] (0/39) | 15.4% [7.2–29.7] (6/39) | 0.0% [0.0–12.5] (0/27) | 0.0% [0.0–12.5] (0/27) |
| current | 5.1% [1.4–16.9] (2/39) | 79.5% [64.5–89.2] (31/39) | 0.0% [0.0–12.5] (0/27) | 25.9% [13.2–44.7] (7/27) |

Spam stopped only by current: 25; only by baseline 249e6c2: 0; exact McNemar p = 6.0e-8.
873 of these cases needed a model that was not asked or did not answer then; the current policy counts them as suspect, so its challenge rates are upper bounds.

### Join requests, every needed model answer on record: 3862 cases; spam 10 (lols 8, admin 2); ham 20 (hand 9, talked 11)

| policy | spam turned away | spam turned away or challenged | ham turned away | ham challenged |
|---|---|---|---|---|
| baseline 249e6c2 | 0.0% [0.0–27.8] (0/10) | 20.0% [5.7–51.0] (2/10) | 0.0% [0.0–16.1] (0/20) | 0.0% [0.0–16.1] (0/20) |
| current | 20.0% [5.7–51.0] (2/10) | 20.0% [5.7–51.0] (2/10) | 0.0% [0.0–16.1] (0/20) | 0.0% [0.0–16.1] (0/20) |

Spam stopped only by current: 0; only by baseline 249e6c2: 0; exact McNemar p = 1.0.


### Direct joins: 4487 cases; spam 867 (hand 33, admin 558, lols 22, ban 254); ham 59 (hand 12, talked 47)

| policy | spam turned away | spam turned away or challenged | ham turned away | ham challenged |
|---|---|---|---|---|
| baseline 249e6c2 | 0.0% [0.0–0.4] (0/867) | 0.0% [0.0–0.4] (0/867) | 0.0% [0.0–6.1] (0/59) | 0.0% [0.0–6.1] (0/59) |
| current | 28.0% [25.1–31.1] (243/867) | 35.2% [32.1–38.4] (305/867) | 0.0% [0.0–6.1] (0/59) | 0.0% [0.0–6.1] (0/59) |

Spam stopped only by current: 305; only by baseline 249e6c2: 0; exact McNemar p = 3.1e-92.
130 of these cases needed a model that was not asked or did not answer then; the current policy counts them as suspect, so its challenge rates are upper bounds.

### Direct joins, every needed model answer on record: 4357 cases; spam 828 (hand 28, admin 547, lols 22, ban 231); ham 59 (hand 12, talked 47)

| policy | spam turned away | spam turned away or challenged | ham turned away | ham challenged |
|---|---|---|---|---|
| baseline 249e6c2 | 0.0% [0.0–0.5] (0/828) | 0.0% [0.0–0.5] (0/828) | 0.0% [0.0–6.1] (0/59) | 0.0% [0.0–6.1] (0/59) |
| current | 29.3% [26.3–32.5] (243/828) | 32.1% [29.0–35.4] (266/828) | 0.0% [0.0–6.1] (0/59) | 0.0% [0.0–6.1] (0/59) |

Spam stopped only by current: 266; only by baseline 249e6c2: 0; exact McNemar p = 1.7e-80.

## Reading it

- **The direct door is where the change is**: 28% of labelled ad accounts that came in
  directly are now removed outright and 35% removed or held (before: none), and no
  labelled person was either. An ad profile is turned away at both doors whatever check
  it could pass: a check proves a person, not an honest one. Of the ads still let
  in, most have no bio and no link, which a profile audit cannot tell from a person; they
  are left to the message rules.
- **At the request door the check itself stops most ads** (they never finish it), so few
  get a label. The extra challenges for people come from model answers that were missing
  under the old 4-second limit; with every answer on record, no labelled person was
  challenged. `live` shows how often a needed model fails to answer now.
- **What these numbers cannot say yet**: a false-positive rate under 0.5%. With zero false
  positives in n people, the 95% upper bound is about 3/n, so a claim of < 0.5% needs at
  least 600 labelled people per door; there are 27 and 59. The same holds for any claim of
  catching 99.5% of ads.

## Targets and gates

- **Label set**: 600 hand-labelled people and 600 ad accounts per door, sampled with
  `door.ts sheet` (a fixed random sample of unlabelled cases) and added to `labels.jsonl`.
  Hand labels override every proxy.
- **Gate for any change to the door**: on the current case file, ham turned away must
  stay at 0 with its upper bound not rising, and spam stopped must not fall (no McNemar
  p < 0.05 in the wrong direction against the policy in production). Add the new policy to
  `POLICIES` in `door.ts`, run `score`, and paste the table here with the commit.
- **Online**: `live` after each deploy. A held or strict-checked person who passes is the
  closest thing to a false-positive label: label them.
