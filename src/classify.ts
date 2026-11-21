// Model judgements for the shadow benchmark: is this newcomer advertising?
// Photos are judged at Telegram's ~320 px size: in bench/ it gave the same verdicts as
// 1280 px at a quarter to a sixth of the cost, though its transcripts drop small print.
// Results are recorded, not acted on, until their false-positive rate is measured
// (CHASM, NeurIPS 2025: zero-shot models reach F1 ~0.6 on covert ads, with low
// precision, so they are not trusted blind).
import { callTelegram, log, messageOf } from "./telegram";
import type { Env } from "./types";

// Workers AI retires models: qwen3-30b-a3b answered nothing from 2026-11-20 (error 5028)
// until it was replaced. `bun bench/models.ts` compares candidates on production cases.
export interface TextModel {
  id: string;
  options?: Record<string, unknown>; // e.g. turning off a reasoning model's thinking
}
export const TEXT_MODEL: TextModel = {
  id: "@cf/google/gemma-4-26b-a4b-it",
  options: { chat_template_kwargs: { enable_thinking: false } }, // else the first token is <|channel>, not yes/no
};
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
Nor is pointing to their own channel, social accounts or a bot for private messages, or
mentioning someone or using a /command in conversation, unless it offers money-making,
goods, services, adult content or a group to join.
Reply with JSON only: {"ad": true|false, "confidence": 0..1, "kind": "none|direct|covert|diversion|adult|scam|other", "reason": "<one short sentence>"}`;

export async function judgeText(env: Env, d: Dossier, model = TEXT_MODEL): Promise<ModelVerdict | null> {
  return run(env, model.id, [
    { role: "system", content: INSTRUCTIONS },
    { role: "user", content: describe(d) },
  ], 300, model.options);
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
  "conversation, complaints, greetings and questions from an ordinary profile are not, nor is a link to " +
  "their own channel or a bot for private messages unless it offers money-making, goods, services, adult " +
  "content or a group to join. " +
  "Answer with exactly one word: yes or no.";

// Part of the bench's cache key, so a changed prompt is asked again.
export const PROMPTS = { decision: DECISION, verdict: INSTRUCTIONS };

export interface Decision {
  model: string;
  p: number; // probability of "yes, this is an ad"
  ms: number;
}

// What each call costs, in neurons, as Cloudflare billed it (about 1.5 for a decision and 3.5
// for a written verdict on gemma-4 on 2026-11-21, 13 for an image on llama-4-scout on
// 2026-11-13), rounded up. Used to keep within the free plan's 10,000 a day.
export const NEURONS = { decision: 2, verdict: 4, image: 15 };

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

export async function decideText(env: Env, d: Dossier, model = TEXT_MODEL): Promise<Decision | null> {
  if (modelsPaused(Date.now())) return null;
  const started = Date.now();
  const text = describe(d);
  try {
    const out = (await env.AI.run(model.id as Parameters<Ai["run"]>[0], {
      messages: [
        { role: "system", content: DECISION },
        { role: "user", content: text },
      ],
      max_tokens: 8,
      logprobs: true,
      top_logprobs: 10,
      ...model.options,
    } as never)) as { choices?: { logprobs?: { content?: { token: string; top_logprobs?: { token: string; logprob: number }[] }[] } }[] };
    const p = yesProbability(out.choices?.[0]?.logprobs?.content ?? []);
    if (p === null) {
      log("decide_unparsed", {});
      return null;
    }
    return { model: model.id, p, ms: Date.now() - started };
  } catch (error) {
    failed("decide_failed", error, model.id);
    return null;
  }
}

// The first yes/no token is the answer; normalise P(yes) against P(no).
export function yesProbability(tokens: { token: string; top_logprobs?: { token: string; logprob: number }[] }[]): number | null {
  const answer = tokens.find((t) => /^\s*(yes|no)\b/i.test(t.token));
  if (!answer?.top_logprobs) return null;
  const mass = (word: string) =>
    answer.top_logprobs!.filter((x) => x.token.trim().toLowerCase() === word).reduce((s, x) => s + Math.exp(x.logprob), 0);
  const yes = mass("yes");
  const no = mass("no");
  return yes + no > 0 ? yes / (yes + no) : null;
}

const AVATAR_INSTRUCTIONS = `You review a Telegram user's profile avatar when they apply to join a group.
Decide whether the avatar image itself is advertising or drawing members elsewhere.
Ordinary portraits, selfies, anime characters, pets, memes, logos and scenery are NOT ads (ad: false).
Only mark ad: true when the avatar displays promotional text, QR codes, contact handles, group/channel links, or adult/gambling/scam offers.
Reply with JSON only: {"ad": true|false, "confidence": 0..1, "kind": "none|direct|covert|diversion|adult|scam|other", "reason": "<one short sentence>", "transcript": "<visible text in image, max 200 chars>"}`;

// Reads the text in a photo and judges it with the same rubric.
export function judgeImage(env: Env, fileId: string, d: Dossier): Promise<ModelVerdict | null> {
  return judgePhoto(
    env,
    fileId,
    d,
    `${INSTRUCTIONS}\nAdd one more field, last: "transcript", the visible text in the image, at most 200 characters.`,
  );
}

// Judges a join requester's profile photo for embedded ads, QR codes, or contact handles.
export function judgeAvatar(env: Env, fileId: string, d: Dossier): Promise<ModelVerdict | null> {
  return judgePhoto(env, fileId, d, AVATAR_INSTRUCTIONS);
}

async function judgePhoto(env: Env, fileId: string, d: Dossier, systemPrompt: string): Promise<ModelVerdict | null> {
  const image = await downloadPhoto(env, fileId).catch((error) => {
    log("photo_download_failed", { error: messageOf(error) });
    return null;
  });
  if (!image) return null;
  // Verdict first, transcript last and short: a dense price list once ran past the token
  // limit mid-transcript, and the cut-off JSON lost the verdict.
  return run(env, VISION_MODEL, [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: [
        { type: "text", text: describe(d) },
        { type: "image_url", image_url: { url: image } },
      ],
    },
  ], 500);
}

async function run(env: Env, model: string, messages: unknown[], maxTokens = 300, options?: Record<string, unknown>): Promise<ModelVerdict | null> {
  if (modelsPaused(Date.now())) return null;
  const started = Date.now();
  try {
    const out = (await env.AI.run(model as Parameters<Ai["run"]>[0], { messages, max_tokens: maxTokens, ...options } as never)) as {
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
