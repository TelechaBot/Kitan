# Spam benchmark

Scores Kitan's detectors on labelled cases with the production code and the real
Workers AI models.

```shell
CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=$(bunx wrangler auth token) bun bench/run.ts --repeat 3
```

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

The seed set is small (9 spam, 20 ham) and the ham is synthetic, so it is a smoke
test, not an estimate of production rates. The real benchmark comes from production:
detectors run in shadow on every newcomer message (`events` rows of kind `verdict`),
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

The first run also caught a false positive in an enforced rule: a person asking
"这个 bot 是群主的吗 @SmartVerifyBot" was read as bot promotion. The rule now needs
the message to be little more than the handle.
