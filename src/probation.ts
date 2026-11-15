// Probation as pure decisions. A member is reviewed only while they have fewer than
// seven clean messages in the last seven days *in that group*; after that the group's
// own life is proof enough, and Kitan leaves them alone. The deterministic rules are
// the Python bot's smallest set: a diversion link, a mention flood, a bare bot handle,
// a link button, a listed word, or a copy.
import { bannedWords } from "./lexicon";
import type { Message } from "./types";

// Probation ends after this many clean messages, all within this rolling window.
export const PROBATION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const PROBATION_MESSAGES = 7;
export const OFFENSE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export type Review = { review: true; why: "probation" } | { review: false; why: "established" };

// Whether a member's recent clean messages in this group still leave them under review.
export function needsReview(recentInWindow: number): Review {
  return recentInWindow < PROBATION_MESSAGES ? { review: true, why: "probation" } : { review: false, why: "established" };
}

export const DUPLICATE_WINDOW_MS = 15 * 60 * 1000;
// The same text this many times within DUPLICATE_WINDOW_MS in one group is a flood:
// a live account posted "最新项目" every 1–3 minutes for hours. People do repeat
// "有人吗?" once or twice; four times in a quarter hour they do not.
export const REPEAT_AT = 4;
// Shorter texts ("hi", "666") are too common to count as the same message across groups.
export const MIN_DUPLICATE_LENGTH = 10;

// The only links the rules act on: places inside Telegram or WhatsApp, or a link that
// carries an invite/affiliate tag. Ordinary web links are conversation.
const DIVERSION_LINK = /(?:t\.me\/|telegram\.me\/|tg:\/\/|wa\.me\/)/i;
const TRACKED_LINK = /(?:\?start=|\?aff=|\/startapp\b)/i;

const MENTION = /@[a-zA-Z0-9_]{3,}/g;
const BOT_MENTION = /@[a-zA-Z0-9_]{2,}bot\b/i;
const BOT_MENTION_ALL = /@[a-zA-Z0-9_]{2,}bot\b/gi;

// A link entity's URL is the target even when the visible text hides it.
function diversionLink(message: Message): boolean {
  if (DIVERSION_LINK.test(messageText(message))) return true;
  const entities = [...(message.entities ?? []), ...(message.caption_entities ?? [])];
  return entities.some(
    (e) =>
      (e.type === "url" || e.type === "text_link") &&
      Boolean(e.url) &&
      (DIVERSION_LINK.test(e.url!) || TRACKED_LINK.test(e.url!)),
  );
}

export type SpamReason =
  | "link"
  | "mentions"
  | "inline_bot"
  | "bot_promo"
  | "keyword"
  | "cross_group_duplicate"
  | "repeated";

export type Verdict =
  | { action: "allow" }
  | { action: "mute"; reason: SpamReason; score: number; until: number }
  | { action: "burn"; reason: SpamReason; score: number };

export interface Judgement {
  reason: SpamReason | null; // from spamReason(), before the duplicate check
  duplicateElsewhere: boolean; // same text from this user in another group within DUPLICATE_WINDOW_MS
  repeatedHere: boolean; // this text REPEAT_AT times in this group within DUPLICATE_WINDOW_MS
  priorOffenses: number; // this user's offenses within OFFENSE_WINDOW_MS, any group
  // Does the sender point people somewhere: a strong target in the name, bio or a contact
  // card, or in the message's text unless that target is what broke the rule
  // (messageTargetCounts)? And has anyone talked with them?
  pointsElsewhere: boolean;
  sociable: boolean;
  now: number;
}

// The penalty grows with the evidence, as no rule is sure. How much each shape says on
// its own: a link may be shared as chat; a bare bot handle or a flood rarely comes from
// a person. A target on the profile is what an ad needs, so it weighs most.
const WEIGHT: Record<SpamReason, number> = {
  link: 1,
  mentions: 2,
  inline_bot: 2,
  keyword: 2,
  bot_promo: 3,
  repeated: 3,
  cross_group_duplicate: 5,
};
export const BAN_AT = 5;
const MINUTE = 60 * 1000;
// By score: 1 is the Python bot's 3 minutes, enough to break a burst; 4 is a day.
const MUTE_FOR = [3 * MINUTE, 3 * MINUTE, 60 * MINUTE, 6 * 60 * MINUTE, 24 * 60 * MINUTE];

export function score(j: Judgement, reason: SpamReason): number {
  return WEIGHT[reason] + (j.pointsElsewhere ? 2 : 0) - (j.sociable ? 1 : 0) + 2 * j.priorOffenses;
}

// The rule a message breaks, if any: its own shape first, then copies of it.
export function ruleOf(j: Pick<Judgement, "reason" | "duplicateElsewhere" | "repeatedHere">): SpamReason | null {
  return j.reason ?? (j.duplicateElsewhere ? "cross_group_duplicate" : j.repeatedHere ? "repeated" : null);
}

// Rules whose evidence is the target itself: a link, handles, buttons. For the others a
// target in the message's own text is extra evidence, as one on the profile is.
const TARGET_IS_THE_RULE: Readonly<Record<SpamReason, boolean>> = {
  link: true,
  mentions: true,
  bot_promo: true,
  inline_bot: true,
  keyword: false,
  repeated: false,
  cross_group_duplicate: false,
};
export function messageTargetCounts(reason: SpamReason): boolean {
  return !TARGET_IS_THE_RULE[reason];
}

export function judge(j: Judgement): Verdict {
  const reason = ruleOf(j);
  if (!reason) return { action: "allow" };
  const s = Math.max(1, score(j, reason));
  if (s >= BAN_AT) return { action: "burn", reason, score: s };
  return { action: "mute", reason, score: s, until: j.now + MUTE_FOR[s] };
}

// An account Kitan banned lately may not join any Kitan group; a mute alone does not bar it.
export function isBlocked(bans: number): boolean {
  return bans > 0;
}

// High-confidence spam shapes only; anything a newcomer plausibly sends is allowed.
export function spamReason(message: Message): SpamReason | null {
  const text = messageText(message);
  const entities = [...(message.entities ?? []), ...(message.caption_entities ?? [])];
  if (diversionLink(message)) return "link";
  if ((text.match(MENTION) ?? []).length >= 4) return "mentions";
  // Pointing at a bot keeps the destination inside Telegram, where link filters do not look.
  // A promo is little more than the handle ("@BSGJUU_bot"); people mention a bot inside a
  // sentence ("这个 bot 是群主的吗 @SmartVerifyBot"), which bench case h11 keeps honest.
  // A slash command naming a bot ("/setu@kmuav2bot") is someone using a bot, not an ad.
  const botCommand = entities.some((e) => e.type === "bot_command") || /^\s*\/[a-z0-9_]+@[a-z0-9_]+bot\b/i.test(text);
  if (
    !botCommand &&
    BOT_MENTION.test(text) &&
    text.replace(BOT_MENTION_ALL, "").replace(/[\s\p{P}\p{S}]/gu, "").length < 10
  ) {
    return "bot_promo";
  }
  // People cannot attach these themselves; they come from bots, inline bots or channel
  // posts, and in a group they are the shape of an ad.
  if (hasLinkButton(message)) return "inline_bot";
  // The keyword layer, as in the Python bot: ads and offers that need no model.
  if (bannedWords(text).length > 0) return "keyword";
  return null;
}

// A button that opens a link.
export function hasLinkButton(message: Message): boolean {
  return (message.reply_markup?.inline_keyboard ?? []).some((row) => row.some((b) => b.url || b.login_url));
}

export function messageText(message: Message): string {
  return message.text ?? message.caption ?? "";
}

// Where an account is trying to send people. An ad only pays if people move: to a
// group, a channel, a bot, a private chat, WeChat or QQ, a phone, or "my profile". So an
// account with no target anywhere (message, name, bio, profile channel, contact card,
// buttons) is not advertising, whatever a model says; that is the false-positive guard.
export type TargetKind = "invite" | "link" | "handle" | "wechat" | "qq" | "phone" | "pointer" | "channel" | "contact" | "button";
export interface Target {
  kind: TargetKind;
  in: "message" | "name" | "bio" | "channel" | "card" | "button";
  value: string;
}

const TARGETS: [TargetKind, RegExp][] = [
  ["invite", /(?:t\.me|telegram\.me)\/(?:\+|joinchat\/)[\w-]+/gi],
  ["link", /(?:https?:\/\/|t\.me\/|telegram\.me\/|tg:\/\/|wa\.me\/)[^\s，。]+/gi],
  ["handle", /@[a-z][a-z0-9_]{3,31}/gi],
  ["wechat", /(?:微信|威信|薇信|v信|vx|wx|weixin|加v|\+v)[:：\s]*[a-z][\w-]{5,19}/gi],
  ["qq", /(?:qq|扣扣|企鹅)[:：\s]*\d{5,11}/gi],
  ["phone", /\+\d[\d -]{8,16}\d|(?<!\d)1[3-9]\d{9}(?!\d)/g],
  // "Look at my profile", "DM me", "join the public group": the ad is one step away.
  // 主业 is how one account wrote 主页 to dodge filters ("看我主业").
  ["pointer", /[看点戳进来]我?的?(?:主[页业]|简介|头像|签名|资料|置顶)|主页(?:有|看|联系)|私(?:聊|我|信我|戳)|滴滴我|dd我|加我|公群|拉你进|进群(?:了解|咨询|领|看)/gi],
];

// Spam writes "t。me", "t . me" and hides zero-width characters to slip past filters.
function plain(text: string): string {
  return text.normalize("NFKC").replace(/[​-‏⁠﻿]/g, "").replace(/\s*[。．·]\s*/g, ".").replace(/t\s*\.\s*me/gi, "t.me");
}

// A profile channel is weak evidence: people keep personal channels too ("来日纵是遇人千万").
export function strong(t: Target): boolean {
  return t.kind !== "channel";
}

export function diversionTargets(where: {
  message?: string;
  name?: string;
  bio?: string;
  channel?: string;
  contact?: string;
  buttons?: string[];
}): Target[] {
  const found: Target[] = [];
  for (const place of ["message", "name", "bio"] as const) {
    const text = where[place];
    if (!text) continue;
    const seen = new Set<string>();
    for (const [kind, pattern] of TARGETS) {
      for (const match of plain(text).matchAll(pattern)) {
        const value = match[0];
        // An invite link is also a link; count it once, as the stronger kind.
        if ([...seen].some((s) => s.includes(value) || value.includes(s))) continue;
        seen.add(value);
        found.push({ kind, in: place, value });
      }
    }
  }
  if (where.channel) found.push({ kind: "channel", in: "channel", value: where.channel });
  if (where.contact) found.push({ kind: "contact", in: "card", value: where.contact });
  for (const url of where.buttons ?? []) found.push({ kind: "button", in: "button", value: url });
  return found;
}

// What makes two messages the same for the duplicate and repeat rules: the text, or for a
// contact card the account or number it shares (a live account posted 140 cards in 4 hours).
export function sameness(message: Message): string {
  const text = messageText(message);
  if (text) return text;
  const c = message.contact;
  return c ? `contact:${c.user_id ?? c.phone_number.replace(/\D/g, "")}` : "";
}

// What a message carries. "service" covers join, leave, pin and title notices, which
// Telegram sends as messages from the member; they are not something the member said.
const CONTENT = [
  "text", "photo", "video", "animation", "sticker", "document", "voice", "video_note", "audio",
  "poll", "contact", "location", "venue", "dice", "game", "story", "paid_media", "giveaway", "checklist",
] as const;
export type Kind = (typeof CONTENT)[number] | "service";

export function messageKind(message: Message): Kind {
  const fields = message as unknown as Record<string, unknown>;
  return CONTENT.find((k) => fields[k] !== undefined) ?? "service";
}

// A fingerprint that survives case, spacing and invisible characters; null for empty text.
export async function contentHash(text: string): Promise<{ hash: string; length: number } | null> {
  const normalized = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[​-‏⁠﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  const hash = [...new Uint8Array(digest).slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { hash, length: [...normalized].length };
}
