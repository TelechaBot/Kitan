// Probation as pure decisions. Spam accounts must post to pay for themselves,
// so a new or silent member's first messages are judged by what that post looks
// like, and a repeat burns the account in every group Kitan serves. People who are
// active in a group are never judged, whatever they post.
import { bannedWords } from "./lexicon";
import type { Message } from "./types";

// Someone who joined a group less than this ago is new there and always reviewed, however
// much they post: otherwise an account could post its way out of review in our own groups.
export const NEWCOMER_MS = 7 * 24 * 60 * 60 * 1000;
// More messages than this across Kitan groups makes someone active.
export const ACTIVE_AFTER = 20;
// An isolation-forest score at or above this marks behaviour as anomalous (≈0.5 is ordinary).
export const ANOMALY_AT = 0.65;
// Cold start: Kitan began counting at deploy, so everyone's count was 0. Someone Kitan never
// saw join who spoke within this long of that is presumed an old regular, not a quiet account.
export const QUIET_MS = 7 * 24 * 60 * 60 * 1000;
export const OFFENSE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export interface Standing {
  joinedAt: number | null; // when Kitan last saw them join this group; null if never
  messages: number; // across all Kitan groups, including this one
  firstAt: number | null; // their first message Kitan counted, in any group
  anomaly: number | null; // isolation-forest score of their behaviour; null without a model
}

export type Review = { review: true; why: "newcomer" | "quiet" | "anomalous" } | { review: false; why: "active" | "regular" };

// Newcomers are always reviewed. Anyone else is left alone only when active across Kitan
// groups (or an old regular from before counting) and their behaviour is not anomalous.
export function needsReview(s: Standing, countingSince: number, now: number): Review {
  if (s.joinedAt !== null && now - s.joinedAt < NEWCOMER_MS) return { review: true, why: "newcomer" };
  const anomalous = s.anomaly !== null && s.anomaly >= ANOMALY_AT;
  if (s.messages > ACTIVE_AFTER) return anomalous ? { review: true, why: "anomalous" } : { review: false, why: "active" };
  const regular = s.joinedAt === null && s.firstAt !== null && s.firstAt - countingSince < QUIET_MS;
  if (regular) return anomalous ? { review: true, why: "anomalous" } : { review: false, why: "regular" };
  return { review: true, why: "quiet" };
}
export const DUPLICATE_WINDOW_MS = 15 * 60 * 1000;
// The same text this many times within DUPLICATE_WINDOW_MS in one group is a flood:
// a live account posted "最新项目" every 1–3 minutes for hours. People do repeat
// "有人吗?" once or twice; four times in a quarter hour they do not.
export const REPEAT_AT = 4;
// Shorter texts ("hi", "666") are too common to count as the same message across groups.
export const MIN_DUPLICATE_LENGTH = 10;

const LINK = /(https?:\/\/|t\.me\/|telegram\.me\/|tg:\/\/|wa\.me\/)/i;
const MENTION = /@[a-zA-Z0-9_]{3,}/g;
const BOT_MENTION = /@[a-zA-Z0-9_]{2,}bot\b/i;
const BOT_MENTION_ALL = /@[a-zA-Z0-9_]{2,}bot\b/gi;

export type SpamReason =
  | "link"
  | "mentions"
  | "forward"
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
  // Beyond the message itself, does the sender point people somewhere: a strong target in
  // the name, bio or a contact card? And has anyone talked with them?
  pointsElsewhere: boolean;
  sociable: boolean;
  now: number;
}

// The penalty grows with the evidence, as no rule is sure. How much each shape says on
// its own: people share links and forwards; a bare bot handle or a flood rarely comes
// from a person. A target on the profile is what an ad needs, so it weighs most.
const WEIGHT: Record<SpamReason, number> = {
  link: 1,
  forward: 1,
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

export function judge(j: Judgement): Verdict {
  const reason = j.reason ?? (j.duplicateElsewhere ? "cross_group_duplicate" : j.repeatedHere ? "repeated" : null);
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
  if (LINK.test(text) || entities.some((e) => e.type === "url" || e.type === "text_link")) return "link";
  if ((text.match(MENTION) ?? []).length >= 4) return "mentions";
  // Pointing at a bot keeps the destination inside Telegram, where link filters do not look.
  // A promo is little more than the handle ("@BSGJUU_bot"); people mention a bot inside a
  // sentence ("这个 bot 是群主的吗 @SmartVerifyBot"), which bench case h11 keeps honest.
  if (BOT_MENTION.test(text) && text.replace(BOT_MENTION_ALL, "").replace(/[\s\p{P}\p{S}]/gu, "").length < 10) {
    return "bot_promo";
  }
  if (message.forward_origin || message.external_reply || message.story) return "forward";
  if (message.via_bot || message.reply_markup) return "inline_bot";
  // The keyword layer, as in the Python bot: ads and offers that need no model.
  if (bannedWords(text).length > 0) return "keyword";
  return null;
}

// A button that opens a link. People cannot attach these themselves; they come from
// bots, inline bots, or channel posts, and in a group they are the shape of an ad.
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
