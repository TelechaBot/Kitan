// Probation as pure decisions. Spam accounts must post to pay for themselves,
// so a new member's first messages are judged by what that post looks like,
// and a repeat burns the account in every group Kitan serves.
import type { Message } from "./types";

export const PROBATION_MS = 24 * 60 * 60 * 1000;
export const PROBATION_MESSAGES = 20;
export const OFFENSE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;
const BLOCK_AFTER_OFFENSES = 2;
const MIN_DUPLICATE_LENGTH = 10;

const LINK = /(https?:\/\/|t\.me\/|telegram\.me\/|tg:\/\/|wa\.me\/)/i;
const MENTION = /@[a-zA-Z0-9_]{3,}/g;

export type SpamReason = "link" | "mentions" | "forward" | "inline_bot" | "cross_group_duplicate";

export type Verdict =
  | { action: "allow" }
  | { action: "mute"; reason: SpamReason; until: number }
  | { action: "burn"; reason: SpamReason };

export interface Judgement {
  reason: SpamReason | null; // from spamReason(), before the duplicate check
  duplicateElsewhere: boolean; // same text from this user in another group within DUPLICATE_WINDOW_MS
  priorOffenses: number; // this user's offenses within OFFENSE_WINDOW_MS, any group
  approvedAt: number;
}

export function judge(j: Judgement): Verdict {
  const reason = j.reason ?? (j.duplicateElsewhere ? "cross_group_duplicate" : null);
  if (!reason) return { action: "allow" };
  if (reason === "cross_group_duplicate" || j.priorOffenses + 1 >= BLOCK_AFTER_OFFENSES) {
    return { action: "burn", reason };
  }
  return { action: "mute", reason, until: j.approvedAt + PROBATION_MS };
}

// Accounts with enough recent offenses may not join any Kitan group.
export function isBlocked(offenses: number): boolean {
  return offenses >= BLOCK_AFTER_OFFENSES;
}

// High-confidence spam shapes only; anything a newcomer plausibly sends is allowed.
export function spamReason(message: Message): SpamReason | null {
  const text = messageText(message);
  const entities = [...(message.entities ?? []), ...(message.caption_entities ?? [])];
  if (LINK.test(text) || entities.some((e) => e.type === "url" || e.type === "text_link")) return "link";
  if ((text.match(MENTION) ?? []).length >= 4) return "mentions";
  if (message.forward_origin || message.external_reply || message.story) return "forward";
  if (message.via_bot || message.reply_markup) return "inline_bot";
  return null;
}

export function messageText(message: Message): string {
  return message.text ?? message.caption ?? "";
}

// A fingerprint that survives case, spacing and invisible characters; null for text too short to compare.
export async function contentHash(text: string): Promise<string | null> {
  const normalized = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[​-‏⁠﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length < MIN_DUPLICATE_LENGTH) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  return [...new Uint8Array(digest).slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
