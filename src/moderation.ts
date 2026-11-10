// Probation for members who joined through Kitan: their first 20 messages
// within 24 hours. Spam accounts must post to pay for themselves, so the
// checks target what that post looks like, and a repeat burns the account in
// every group Kitan serves.
import { callTelegram, log } from "./telegram";
import type { Env, Message } from "./types";

const PROBATION_MS = 24 * 60 * 60 * 1000;
const PROBATION_MESSAGES = 20;
const OFFENSE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;
const BLOCK_AFTER_OFFENSES = 2;

const LINK = /(https?:\/\/|t\.me\/|telegram\.me\/|tg:\/\/|wa\.me\/)/i;
const MENTION = /@[a-zA-Z0-9_]{3,}/g;

const MUTED = {
  can_send_messages: false,
  can_send_audios: false,
  can_send_documents: false,
  can_send_photos: false,
  can_send_videos: false,
  can_send_video_notes: false,
  can_send_voice_notes: false,
  can_send_polls: false,
  can_send_other_messages: false,
  can_add_web_page_previews: false,
};

// High-confidence spam shapes only; anything a newcomer plausibly sends is allowed.
export function spamReason(message: Message): string | null {
  const text = message.text ?? message.caption ?? "";
  const entities = [...(message.entities ?? []), ...(message.caption_entities ?? [])];
  if (LINK.test(text) || entities.some((e) => e.type === "url" || e.type === "text_link")) {
    return "link";
  }
  if ((text.match(MENTION) ?? []).length >= 4) {
    return "mentions";
  }
  if (message.forward_origin || message.external_reply || message.story) {
    return "forward";
  }
  if (message.via_bot || message.reply_markup) {
    return "inline_bot";
  }
  return null;
}

async function contentHash(text: string): Promise<string> {
  const normalized = text.normalize("NFKC").toLowerCase().replace(/[​-‏⁠﻿]/g, "").replace(/\s+/g, " ").trim();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  return [...new Uint8Array(digest).slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function isBlocked(env: Env, userId: string, now: number): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT count(*) AS n FROM offenses WHERE user_id = ? AND at > ?`)
    .bind(userId, now - OFFENSE_WINDOW_MS)
    .first<{ n: number }>();
  return (row?.n ?? 0) >= BLOCK_AFTER_OFFENSES;
}

export async function onGroupMessage(env: Env, message: Message, now: number): Promise<void> {
  if (!message.from || message.from.is_bot) {
    return;
  }
  const chatId = String(message.chat.id);
  const userId = String(message.from.id);

  // Only members Kitan approved recently are on probation.
  const member = await env.DB.prepare(
    `UPDATE attempts SET messages = messages + 1
     WHERE id = (SELECT id FROM attempts
                 WHERE chat_id = ? AND user_id = ? AND status = 'approved' AND decided_at > ?
                   AND messages < ? AND banned_at IS NULL
                 ORDER BY decided_at DESC LIMIT 1)
     RETURNING decided_at`,
  )
    .bind(chatId, userId, now - PROBATION_MS, PROBATION_MESSAGES)
    .first<{ decided_at: number }>();
  if (!member) {
    return;
  }

  let reason = spamReason(message);
  const text = message.text ?? message.caption ?? "";
  if (!reason && text.trim().length >= 10) {
    const hash = await contentHash(text);
    const elsewhere = await env.DB.prepare(
      `SELECT 1 FROM recent_messages WHERE user_id = ? AND hash = ? AND chat_id != ? AND at > ? LIMIT 1`,
    )
      .bind(userId, hash, chatId, now - DUPLICATE_WINDOW_MS)
      .first();
    await env.DB.prepare(`INSERT INTO recent_messages (user_id, chat_id, hash, at) VALUES (?, ?, ?, ?)`)
      .bind(userId, chatId, hash, now)
      .run();
    if (elsewhere) {
      reason = "cross_group_duplicate";
    }
  }
  if (!reason) {
    return;
  }

  await callTelegram(env, "deleteMessage", { chat_id: chatId, message_id: message.message_id }).catch(
    (error) => log("delete_failed", { chat_id: chatId, error: String(error) }),
  );
  await env.DB.prepare(`INSERT INTO offenses (user_id, chat_id, reason, at) VALUES (?, ?, ?, ?)`)
    .bind(userId, chatId, reason, now)
    .run();

  if (reason === "cross_group_duplicate" || (await isBlocked(env, userId, now))) {
    await burnAccount(env, userId, now);
    log("spam_blocked", { chat_id: chatId, user_id: userId, reason });
    return;
  }
  await callTelegram(env, "restrictChatMember", {
    chat_id: chatId,
    user_id: userId,
    permissions: MUTED,
    use_independent_chat_permissions: true,
    until_date: Math.floor((member.decided_at + PROBATION_MS) / 1000),
  }).catch((error) => log("restrict_failed", { chat_id: chatId, error: String(error) }));
  log("spam_muted", { chat_id: chatId, user_id: userId, reason });
}

// Ban the account from every group where it is still on probation, removing its messages.
async function burnAccount(env: Env, userId: string, now: number): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT chat_id FROM attempts WHERE user_id = ? AND status = 'approved' AND decided_at > ?`,
  )
    .bind(userId, now - PROBATION_MS)
    .all<{ chat_id: string }>();
  for (const { chat_id } of results) {
    await callTelegram(env, "banChatMember", { chat_id, user_id: userId, revoke_messages: true }).catch(
      (error) => log("ban_failed", { chat_id, error: String(error) }),
    );
  }
}

export async function pruneModeration(env: Env, now: number): Promise<void> {
  await env.DB.prepare(`DELETE FROM recent_messages WHERE at <= ?`).bind(now - DUPLICATE_WINDOW_MS).run();
  await env.DB.prepare(`DELETE FROM offenses WHERE at <= ?`).bind(now - OFFENSE_WINDOW_MS).run();
}

// Shared spam list (https://lols.bot, free, no key). Fails open: an outage must not block real people.
export async function lolsBanned(userId: string): Promise<boolean | null> {
  try {
    const response = await fetch(`https://api.lols.bot/account?id=${userId}`, {
      signal: AbortSignal.timeout(2_000),
    });
    const body = (await response.json()) as { ok?: boolean; banned?: boolean };
    return body.ok ? body.banned === true : null;
  } catch {
    return null;
  }
}
