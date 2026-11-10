// One-off notes to the admins of every group Kitan serves. Each admin gets a
// note once per group: by DM when they have talked to the bot, otherwise as an
// ephemeral message in the group, which Telegram delivers only if they are online.
import { chatsSeen } from "./db";
import { callTelegram, isRefused, log, messageOf } from "./telegram";
import type { Env } from "./types";

// Bump the id when the text changes in substance, so admins receive the new note.
export const NOTICE_ID = "2026-11-old-requests-guard-bot";

function noticeText(bot: string, group: string): string {
  return [
    `Hi! A quick note from the maintainers of @${bot} about ${group}:`,
    "",
    "1. Old join requests. Some requests sent before the bot started handling your group may still be waiting. " +
      "People with a pending request can't ask to join again until it's answered, and the bot can't see requests " +
      "from before it was active. If you find old ones under Group settings → Join requests, declining them lets " +
      "those people ask again, and the bot will check them as usual.",
    "",
    `2. Guard bot mode. If your group settings offer a guard bot for join requests, choosing @${bot} opens the ` +
      "check as soon as someone asks to join, so it no longer depends on a private message.",
    "",
    `Thanks for using @${bot}!`,
  ].join("\n");
}

interface Admin {
  status: "creator" | "administrator";
  can_change_info?: boolean;
  user: { id: number; is_bot?: boolean };
}

// The group's owner, who can both clear join requests and change group settings;
// if the owner is not listed, the admins who may change group settings.
function recipients(admins: Admin[]): Admin[] {
  const people = admins.filter((a) => !a.user.is_bot);
  const owner = people.filter((a) => a.status === "creator");
  return owner.length ? owner : people.filter((a) => a.can_change_info === true);
}

type Via = "dm" | "ephemeral" | "failed";

// Without `send`, reports who would receive the note and sends nothing.
export async function notifyAdmins(env: Env, send: boolean, now: number) {
  const me = await callTelegram<{ username: string }>(env, "getMe", {});
  const report = [];
  for (const chat of await chatsSeen(env.DB)) {
    const group = chat.chat_title ?? chat.chat_id;
    const admins = await callTelegram<Admin[]>(env, "getChatAdministrators", { chat_id: chat.chat_id }).catch(
      (error) => {
        log("notice_admins_failed", { chat_id: chat.chat_id, error: messageOf(error) });
        return [];
      },
    );
    const people = recipients(admins).map((a) => String(a.user.id));
    const { results } = await env.DB.prepare(
      `SELECT user_id FROM admin_notices WHERE notice = ? AND chat_id = ?`,
    )
      .bind(NOTICE_ID, chat.chat_id)
      .all<{ user_id: string }>();
    const done = new Set(results.map((r) => r.user_id));
    const todo = people.filter((id) => !done.has(id));

    const sent: Record<Via, number> = { dm: 0, ephemeral: 0, failed: 0 };
    if (send) {
      const text = noticeText(me.username, group);
      for (const userId of todo) {
        const via = await deliver(env, chat.chat_id, userId, text);
        sent[via] += 1;
        await env.DB.prepare(`INSERT OR IGNORE INTO admin_notices (notice, chat_id, user_id, via, at) VALUES (?, ?, ?, ?, ?)`)
          .bind(NOTICE_ID, chat.chat_id, userId, via, now)
          .run();
      }
    }
    report.push({ group, admins: people.length, already_notified: done.size, ...(send ? sent : { to_notify: todo.length }) });
  }
  return { notice: NOTICE_ID, sent: send, groups: report };
}

async function deliver(env: Env, chatId: string, userId: string, text: string): Promise<Via> {
  try {
    await callTelegram(env, "sendMessage", { chat_id: userId, text, link_preview_options: { is_disabled: true } });
    return "dm";
  } catch (error) {
    if (!isRefused(error)) log("notice_dm_failed", { chat_id: chatId, error: messageOf(error) });
  }
  try {
    await callTelegram(env, "sendMessage", {
      chat_id: chatId,
      text,
      link_preview_options: { is_disabled: true },
      ephemeral_message_parameters: { receiver_user_id: Number(userId) },
    });
    return "ephemeral";
  } catch (error) {
    log("notice_ephemeral_failed", { chat_id: chatId, error: messageOf(error) });
    return "failed";
  }
}
