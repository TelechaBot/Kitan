// One-off notes to the admins of every group Kitan serves. Each admin gets a
// note once per group: by DM when they have talked to the bot, otherwise as an
// ephemeral message in the group, which Telegram delivers only if they are online.
import { type LinkTally, chatTitle, chatsSeen, inviteLinksWithAds, lastNoticeAt, recordNotice } from "./db";
import { botUsername, callTelegram, isRefused, log, messageOf } from "./telegram";
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

// ---------- invite links that bring in ads ----------

// Invite links let people in without the bot's check, by design: an admin hands them to
// people they trust. Rarely, a link travels further and brings mostly ad accounts; then,
// and only then, the owner hears about it, once in 30 days per link. On 2026-11-13 four
// links in one group had brought 85 people in a week, 69 of whom the bot removed.
const LINK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const LINK_MIN_REMOVED = 10;
const LINK_QUIET_MS = 30 * 24 * 60 * 60 * 1000;

function linkNoticeText(bot: string, group: string, links: LinkTally[]): string {
  const lines = links.map((l) => {
    const by = l.creator ? `, made by ${l.creator.replace(/^(user|bot):/, "")}` : "";
    return `• "${l.link}"${by}: ${l.joined} joined, ${l.removed} removed or muted`;
  });
  return [
    `Hi! A note from @${bot} about ${group}.`,
    "",
    `In the last 7 days, most people who joined through ${links.length === 1 ? "this invite link were" : "these invite links were"} ad accounts, which the bot removed or muted for posting ads:`,
    ...lines,
    "",
    "People who join through an invite link don't go through the bot's join check. If a link has travelled " +
      "further than you meant, you can revoke it, or turn on \"Request admin approval\" for it under Group settings → " +
      "Invite links, so the bot checks the people who use it.",
    "",
    `You won't hear about ${links.length === 1 ? "this link" : "these links"} again for 30 days.`,
  ].join("\n");
}

// Run daily. Each group's owner gets one note listing its links that crossed the line.
export async function noticeInviteLinks(env: Env, now: number): Promise<void> {
  const byChat = new Map<string, LinkTally[]>();
  for (const tally of await inviteLinksWithAds(env.DB, now - LINK_WINDOW_MS, LINK_MIN_REMOVED)) {
    const last = await lastNoticeAt(env.DB, `invite-link:${tally.link}`, tally.chatId);
    if (last !== null && now - last < LINK_QUIET_MS) continue;
    byChat.set(tally.chatId, [...(byChat.get(tally.chatId) ?? []), tally]);
  }
  if (!byChat.size) return;
  const bot = await botUsername(env);
  for (const [chatId, links] of byChat) {
    const group = (await chatTitle(env.DB, chatId)) ?? chatId;
    const admins = await callTelegram<Admin[]>(env, "getChatAdministrators", { chat_id: chatId }).catch((error) => {
      log("link_notice_admins_failed", { chat_id: chatId, error: messageOf(error) });
      return [];
    });
    const text = linkNoticeText(bot, group, links);
    for (const owner of recipients(admins)) {
      const via = await deliver(env, chatId, String(owner.user.id), text);
      for (const l of links) await recordNotice(env.DB, `invite-link:${l.link}`, chatId, String(owner.user.id), via, now);
      log("link_notice_sent", { chat_id: chatId, links: links.length, via });
    }
  }
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
