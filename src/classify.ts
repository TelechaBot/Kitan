// Model judgements for the shadow benchmark: is this newcomer advertising?
// Photos are judged at Telegram's ~320 px size: in bench/ it gave the same verdicts as
// 1280 px at a quarter to a sixth of the cost, though its transcripts drop small print.
// Results are recorded, not acted on, until their false-positive rate is measured
// (CHASM, NeurIPS 2025: zero-shot models reach F1 ~0.6 on covert ads, with low
// precision, so they are not trusted blind).
import { callTelegram, log, messageOf } from "./telegram";
import type { Env } from "./types";

const TEXT_MODEL = "@cf/qwen/qwen3-30b-a3b-fp8";
const VISION_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";

export type AdKind = "none" | "direct" | "covert" | "diversion" | "adult" | "scam" | "other";

export interface ModelVerdict {
  model: string;
  ad: boolean;
  confidence: number;
  kind: AdKind;
  reason: string;
  transcript?: string; // text read from an image
  ms: number;
}

// Everything Kitan knows about a message's sender, as the models see it. Fields left out
// are not shown, so a replay can ask what each one is worth (bench/replay.ts).
export interface Dossier {
  group?: string; // the group's title
  name: string;
  username?: string;
  bio?: string;
  personalChat?: string; // the channel pinned to their profile
  accountYears?: number; // estimated from the user id
  admittedBy?: string; // "Kitan's check", another bot, an admin, an invite link, or themselves
  minutesSinceJoin?: number | null; // null: Kitan never saw them join this group
  messages?: number; // across Kitan groups, this one included
  groups?: number; // Kitan groups they have spoken in
  kind?: string; // text, photo, video, sticker, …
  edited: boolean;
  text: string;
}

// What production shows the models: the profile and the message. On 41 hand-labelled
// production accounts (bench/replay.ts, 2026-11-12) this caught 26 of 29 spam accounts
// with no false positive at P ≥ 0.8; adding the group, how they came in, account age,
// time since joining and message count lowered that to 18, whichever field was left out.
export function forModels(d: Dossier): Dossier {
  return { name: d.name, username: d.username, bio: d.bio, personalChat: d.personalChat, kind: d.kind, edited: d.edited, text: d.text };
}

export function describe(d: Dossier): string {
  const joined =
    d.minutesSinceJoin === undefined
      ? ""
      : d.minutesSinceJoin === null
        ? "joined: before Kitan started watching"
        : `joined: ${d.minutesSinceJoin < 120 ? `${d.minutesSinceJoin} minutes` : `${Math.round(d.minutesSinceJoin / 60)} hours`} ago`;
  return [
    d.group ? `group: ${d.group}` : "",
    `display name: ${d.name}`,
    d.username ? `username: @${d.username}` : "",
    d.bio ? `bio: ${d.bio}` : "",
    d.personalChat ? `channel on their profile: ${d.personalChat}` : "",
    d.accountYears !== undefined ? `account age: about ${d.accountYears < 1 ? `${Math.max(1, Math.round(d.accountYears * 12))} months` : `${d.accountYears.toFixed(1)} years`}` : "",
    d.admittedBy ? `admitted by: ${d.admittedBy}` : "",
    joined,
    d.messages !== undefined ? `messages so far: ${d.messages} in ${d.groups ?? 1} group(s)` : "",
    `message${d.kind && d.kind !== "text" ? ` (${d.kind})` : ""}${d.edited ? " (an edit)" : ""}: ${d.text || "(no text)"}`,
  ]
    .filter(Boolean)
    .join("\n");
}

const INSTRUCTIONS = `You review messages in Telegram groups from new or rarely seen members.
Decide whether the sender is advertising or drawing members elsewhere. That includes:
direct ads; covert ads written as chat or personal stories (e.g. "女生赚钱越来越难了");
diversion to a bot, channel, private chat, WeChat/QQ or another group; adult services;
investment, crypto or job scams. Spam accounts often post something harmless and keep
the ad in their display name, username or bio, so judge the sender as a whole.
An ordinary greeting or question from someone with an ordinary profile is NOT an ad.
Reply with JSON only: {"ad": true|false, "confidence": 0..1, "kind": "none|direct|covert|diversion|adult|scam|other", "reason": "<one short sentence>"}`;

export async function judgeText(env: Env, d: Dossier): Promise<ModelVerdict | null> {
  return run(env, TEXT_MODEL, [
    { role: "system", content: INSTRUCTIONS },
    { role: "user", content: `${describe(d)}\n/no_think` },
  ]);
}

// A decision rather than a written verdict, in the manner of typesafe.ai's jev: the model
// answers one token, yes or no, and the probability it gave "yes" is the score, which
// Kitan thresholds itself. About a quarter of judgeText's cost, and the score is a real
// probability rather than a self-reported confidence.
// Longer wording did worse: naming covert-ad cues lowered recall on production accounts from
// 26 to 20 of 29 and still missed the seed set's covert pitch (bench/README.md).
const DECISION =
  "Is the sender of this message in a Telegram group advertising or drawing members elsewhere " +
  "(including covert ads written as personal stories, adult services, scams, or pointing people to a " +
  "bot, channel or private chat), in the message or in their name, username or bio? Ordinary " +
  "conversation, complaints, greetings and questions from an ordinary profile are not. " +
  "Answer with exactly one word: yes or no.";

// Part of the bench's cache key, so a changed prompt is asked again.
export const PROMPTS = { decision: DECISION, verdict: INSTRUCTIONS };

export interface Decision {
  model: string;
  p: number; // probability of "yes, this is an ad"
  ms: number;
}

// What each call costs, in neurons, as Cloudflare billed it on 2026-11-13 (about 0.8 for a
// decision and 2.6 for a written verdict on qwen3, 13 for an image on llama-4-scout),
// rounded up. Used to keep within the free plan's 10,000 a day.
export const NEURONS = { decision: 1, verdict: 3, image: 15 };

// Once the free allowance is spent every call fails until it frees up again; after the
// first such failure this Worker instance stops asking for half an hour.
let pausedUntil = 0;
export function modelsPaused(now: number): boolean {
  return now < pausedUntil;
}

function failed(event: string, error: unknown, model?: string) {
  const message = messageOf(error);
  if (/daily free allocation|\b4006\b/.test(message)) pausedUntil = Date.now() + 30 * 60 * 1000;
  log(event, { model, error: message });
}

export async function decideText(env: Env, d: Dossier): Promise<Decision | null> {
  if (modelsPaused(Date.now())) return null;
  const started = Date.now();
  const text = describe(d);
  try {
    const out = (await env.AI.run(TEXT_MODEL as Parameters<Ai["run"]>[0], {
      messages: [
        { role: "system", content: DECISION },
        { role: "user", content: `${text}\n/no_think` },
      ],
      max_tokens: 8,
      logprobs: true,
      top_logprobs: 10,
    } as never)) as { choices?: { logprobs?: { content?: { token: string; top_logprobs?: { token: string; logprob: number }[] }[] } }[] };
    const p = yesProbability(out.choices?.[0]?.logprobs?.content ?? []);
    if (p === null) {
      log("decide_unparsed", {});
      return null;
    }
    return { model: TEXT_MODEL, p, ms: Date.now() - started };
  } catch (error) {
    failed("decide_failed", error);
    return null;
  }
}

// The answer token comes after an empty <think> block; normalise P(yes) against P(no).
export function yesProbability(tokens: { token: string; top_logprobs?: { token: string; logprob: number }[] }[]): number | null {
  const answer = tokens.find((t) => /^\s*(yes|no)\b/i.test(t.token));
  if (!answer?.top_logprobs) return null;
  const mass = (word: string) =>
    answer.top_logprobs!.filter((x) => x.token.trim().toLowerCase() === word).reduce((s, x) => s + Math.exp(x.logprob), 0);
  const yes = mass("yes");
  const no = mass("no");
  return yes + no > 0 ? yes / (yes + no) : null;
}

// Reads the text in a photo and judges it with the same rubric.
export async function judgeImage(env: Env, fileId: string, d: Dossier): Promise<ModelVerdict | null> {
  const image = await downloadPhoto(env, fileId).catch((error) => {
    log("photo_download_failed", { error: messageOf(error) });
    return null;
  });
  if (!image) return null;
  // Verdict first, transcript last and short: a dense price list once ran past the token
  // limit mid-transcript, and the cut-off JSON lost the verdict.
  return run(env, VISION_MODEL, [
    {
      role: "system",
      content: `${INSTRUCTIONS}\nAdd one more field, last: "transcript", the visible text in the image, at most 200 characters.`,
    },
    {
      role: "user",
      content: [
        { type: "text", text: describe(d) },
        { type: "image_url", image_url: { url: image } },
      ],
    },
  ], 500);
}

async function run(env: Env, model: string, messages: unknown[], maxTokens = 300): Promise<ModelVerdict | null> {
  if (modelsPaused(Date.now())) return null;
  const started = Date.now();
  try {
    const out = (await env.AI.run(model as Parameters<Ai["run"]>[0], { messages, max_tokens: maxTokens } as never)) as {
      response?: string | Record<string, unknown>;
      choices?: { message?: { content?: string } }[];
    };
    const raw = typeof out.response === "object" ? JSON.stringify(out.response) : (out.response ?? out.choices?.[0]?.message?.content ?? "");
    const parsed = parseVerdict(raw);
    if (!parsed) {
      log("classify_unparsed", { model, raw: raw.slice(0, 200) });
      return null;
    }
    return { model, ...parsed, ms: Date.now() - started };
  } catch (error) {
    failed("classify_failed", error, model);
    return null;
  }
}

// Models wrap JSON in prose or <think> blocks; take the first JSON object. When the
// reply was cut off, read the verdict fields that arrived before the cut.
export function parseVerdict(raw: string): Omit<ModelVerdict, "model" | "ms"> | null {
  const body = raw.replace(/<think>[\s\S]*?<\/think>/g, "");
  const start = body.indexOf("{");
  if (start < 0) return null;
  const end = body.lastIndexOf("}");
  let v: Record<string, unknown> | null = null;
  try {
    v = end > start ? (JSON.parse(body.slice(start, end + 1)) as Record<string, unknown>) : null;
  } catch {
    v = null;
  }
  v ??= salvage(body.slice(start));
  if (!v || typeof v.ad !== "boolean") return null;
  const confidence = Number(v.confidence);
  return {
    ad: v.ad,
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.5,
    kind: (typeof v.kind === "string" ? v.kind : "other") as AdKind,
    reason: String(v.reason ?? "").slice(0, 200),
    ...(typeof v.transcript === "string" ? { transcript: v.transcript.slice(0, 500) } : {}),
  };
}

function salvage(partial: string): Record<string, unknown> | null {
  const ad = /"ad"\s*:\s*(true|false)/.exec(partial);
  if (!ad) return null;
  const field = (name: string) => new RegExp(`"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(partial)?.[1];
  return {
    ad: ad[1] === "true",
    confidence: /"confidence"\s*:\s*([0-9.]+)/.exec(partial)?.[1],
    kind: field("kind"),
    reason: field("reason"),
    transcript: field("transcript"),
  };
}

async function downloadPhoto(env: Env, fileId: string): Promise<string> {
  const file = await callTelegram<{ file_path: string }>(env, "getFile", { file_id: fileId });
  const response = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`, {
    signal: AbortSignal.timeout(10_000),
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:image/jpeg;base64,${btoa(binary)}`;
}
