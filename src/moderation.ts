// Runs probation: gathers what judge() needs, records the verdict, and acts on it in Telegram.
import {
  chatsApprovedSince,
  countOffenses,
  countProbationMessage,
  insertOffense,
  prune,
  seenElsewhere,
} from "./db";
import {
  DUPLICATE_WINDOW_MS,
  OFFENSE_WINDOW_MS,
  PROBATION_MESSAGES,
  PROBATION_MS,
  contentHash,
  judge,
  messageText,
  spamReason,
} from "./probation";
import { pickLang, t } from "./i18n";
import { callTelegram, log, messageOf } from "./telegram";
import type { Env, Message } from "./types";

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

export async function onGroupMessage(env: Env, message: Message, now: number): Promise<void> {
  if (!message.from || message.from.is_bot) return;
  const chatId = String(message.chat.id);
  const userId = String(message.from.id);

  // Only members Kitan approved recently are on probation.
  const approvedAt = await countProbationMessage(env.DB, chatId, userId, now - PROBATION_MS, PROBATION_MESSAGES);
  if (approvedAt === null) return;

  const reason = spamReason(message);
  const hash = reason ? null : await contentHash(messageText(message));
  const duplicateElsewhere = hash
    ? await seenElsewhere(env.DB, userId, chatId, hash, now - DUPLICATE_WINDOW_MS, now)
    : false;
  if (!reason && !duplicateElsewhere) return;

  const priorOffenses = await countOffenses(env.DB, userId, now - OFFENSE_WINDOW_MS);
  const verdict = judge({ reason, duplicateElsewhere, priorOffenses, approvedAt });
  if (verdict.action === "allow") return;

  await insertOffense(env.DB, userId, chatId, verdict.reason, now);
  await telegram(env, "deleteMessage", { chat_id: chatId, message_id: message.message_id });
  if (verdict.action === "mute") {
    const until = Math.floor(verdict.until / 1000);
    await telegram(env, "restrictChatMember", {
      chat_id: chatId,
      user_id: userId,
      permissions: MUTED,
      use_independent_chat_permissions: true,
      until_date: until,
    });
    // Tell only them why and until when; a real newcomer should not be left guessing.
    // Telegram shows the time in their own time zone; the text inside is the fallback.
    const fallback = `${new Date(verdict.until).toISOString().slice(0, 16).replace("T", " ")} UTC`;
    await telegram(env, "sendMessage", {
      chat_id: chatId,
      text: t(pickLang(message.from.language_code), "muted", {
        time: `<tg-time unix="${until}" format="dt">${fallback}</tg-time>`,
      }),
      parse_mode: "HTML",
      ephemeral_message_parameters: { receiver_user_id: message.from.id },
    });
  } else {
    // Ban the account wherever it is still new, removing its messages there too.
    for (const chat of await chatsApprovedSince(env.DB, userId, now - PROBATION_MS)) {
      await telegram(env, "banChatMember", { chat_id: chat, user_id: userId, revoke_messages: true });
    }
  }
  log(verdict.action === "mute" ? "spam_muted" : "spam_blocked", { chat_id: chatId, user_id: userId, reason: verdict.reason });
}

export async function pruneModeration(env: Env, now: number): Promise<void> {
  await prune(env.DB, now - DUPLICATE_WINDOW_MS, now - OFFENSE_WINDOW_MS);
}

// Moderation calls are best effort: a missing admin right must not stop the rest.
async function telegram(env: Env, method: string, params: Record<string, unknown>): Promise<void> {
  await callTelegram(env, method, params).catch((error) =>
    log(`${method}_failed`, { chat_id: params.chat_id, error: messageOf(error) }),
  );
}
