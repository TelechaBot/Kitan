// Model judgements for the shadow benchmark: is this newcomer advertising?
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

export interface Subject {
  name: string;
  username?: string;
  bio?: string;
  personalChat?: string;
  approvedBy?: string;
  minutesSinceJoin: number;
  index: number; // 1 for their first message in the group
  edited: boolean;
  text: string;
}

const INSTRUCTIONS = `You review messages from people who joined a Telegram group less than a day ago.
Decide whether the sender is advertising or drawing members elsewhere. That includes:
direct ads; covert ads written as chat or personal stories (e.g. "女生赚钱越来越难了");
diversion to a bot, channel, private chat, WeChat/QQ or another group; adult services;
investment, crypto or job scams. Spam accounts often first post a harmless greeting
and later edit it, or put the ad in their display name, username or bio.
An ordinary greeting or question with nothing else is NOT an ad.
Reply with JSON only: {"ad": true|false, "confidence": 0..1, "kind": "none|direct|covert|diversion|adult|scam|other", "reason": "<one short sentence>"}`;

export async function judgeText(env: Env, s: Subject): Promise<ModelVerdict | null> {
  const facts = [
    `display name: ${s.name}`,
    s.username ? `username: @${s.username}` : "",
    s.bio ? `bio: ${s.bio}` : "",
    s.personalChat ? `channel on their profile: ${s.personalChat}` : "",
    s.approvedBy ? `admitted by: ${s.approvedBy}` : "",
    `joined ${s.minutesSinceJoin} minutes ago; this is their message #${s.index}${s.edited ? " (an edit)" : ""}`,
    `message: ${s.text || "(no text)"}`,
  ].filter(Boolean);
  return run(env, TEXT_MODEL, [
    { role: "system", content: INSTRUCTIONS },
    { role: "user", content: `${facts.join("\n")}\n/no_think` },
  ]);
}

// Reads the text in a photo and judges it with the same rubric.
export async function judgeImage(env: Env, fileId: string, s: Subject): Promise<ModelVerdict | null> {
  const image = await downloadPhoto(env, fileId).catch((error) => {
    log("photo_download_failed", { error: messageOf(error) });
    return null;
  });
  if (!image) return null;
  return run(env, VISION_MODEL, [
    { role: "system", content: `${INSTRUCTIONS}\nAlso add "transcript": the text visible in the image.` },
    {
      role: "user",
      content: [
        { type: "text", text: `display name: ${s.name}\ncaption: ${s.text || "(none)"}` },
        { type: "image_url", image_url: { url: image } },
      ],
    },
  ]);
}

async function run(env: Env, model: string, messages: unknown[]): Promise<ModelVerdict | null> {
  const started = Date.now();
  try {
    const out = (await env.AI.run(model as Parameters<Ai["run"]>[0], { messages, max_tokens: 300 } as never)) as {
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
    log("classify_failed", { model, error: messageOf(error) });
    return null;
  }
}

// Models wrap JSON in prose or <think> blocks; take the first JSON object.
export function parseVerdict(raw: string): Omit<ModelVerdict, "model" | "ms"> | null {
  const body = raw.replace(/<think>[\s\S]*?<\/think>/g, "");
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const v = JSON.parse(body.slice(start, end + 1)) as Record<string, unknown>;
    if (typeof v.ad !== "boolean") return null;
    const confidence = Number(v.confidence);
    return {
      ad: v.ad,
      confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.5,
      kind: (typeof v.kind === "string" ? v.kind : "other") as AdKind,
      reason: String(v.reason ?? "").slice(0, 200),
      ...(typeof v.transcript === "string" ? { transcript: v.transcript.slice(0, 500) } : {}),
    };
  } catch {
    return null;
  }
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
