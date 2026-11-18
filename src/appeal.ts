// Lifting a mute by passing the check again. A muted newcomer sees, privately in the group,
// a button that opens the bot; there they get the same Turnstile check as at the door, and
// passing it lifts the mute at once. No rule is sure, so a person should not have to wait
// out a mistake; an ad account can pass it too, but only once in 30 days, and the offense
// still counts towards the next penalty. Bans have no such way back: they take a score of
// 5, which this check cannot argue with. A direct joiner muted for an ad profile gets the
// strict check here (two Turnstile checks and one sum), as a second join request would.
import type { ChallengeState } from "./attempt";
import { appealsPassedSince, chatTitle, findAppeal, insertAppeal, markAppealPassed, recordEvent, type Appeal } from "./db";
import { pickLang, t } from "./i18n";
import { botUsername, callTelegram, log, messageOf, sendPermissions } from "./telegram";
import type { Env, TelegramUser } from "./types";

const PREFIX = "u";
const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export function isAppealToken(token: string | undefined): token is string {
  return typeof token === "string" && token.startsWith(PREFIX) && /^u[0-9a-f]{24}$/.test(token);
}

// Called with each mute: records the appeal and returns the button for the notice, if the
// bot's username can be read to link to it.
export async function offerAppeal(
  env: Env,
  mute: {
    chatId: string;
    userId: string;
    rule: string;
    score: number;
    until: number;
    lang: string | undefined;
    challenge?: ChallengeState;
    kickAt?: number;
  },
  now: number,
): Promise<{ text: string; url: string } | null> {
  const token = newToken();
  await insertAppeal(env.DB, {
    token,
    chatId: mute.chatId,
    userId: mute.userId,
    rule: mute.rule,
    score: mute.score,
    createdAt: now,
    until: mute.until,
    challenge: mute.challenge ?? null,
    kickAt: mute.kickAt ?? null,
  });
  const bot = await botUsername(env).catch(() => null);
  return bot ? { text: t(pickLang(mute.lang), "unmuteButton"), url: `https://t.me/${bot}?start=${token}` } : null;
}

// An ad profile's removal, due at kickAt (moderation.ts sweepHolds). Stored as an appeal no
// one is offered, so the one sweep removes both these and held members who did not pass.
export async function scheduleRemoval(env: Env, r: { chatId: string; userId: string; kickAt: number }, now: number): Promise<void> {
  await insertAppeal(env.DB, {
    token: newToken(),
    chatId: r.chatId,
    userId: r.userId,
    rule: "ad_profile",
    score: 0,
    createdAt: now,
    until: r.kickAt,
    challenge: null,
    kickAt: r.kickAt,
  });
}

function newToken(): string {
  return PREFIX + [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type AppealRefusal = "none" | "used";

// Whether this person may use this appeal now.
export async function checkAppeal(env: Env, token: string, userId: number, now: number): Promise<Appeal | AppealRefusal> {
  const appeal = await findAppeal(env.DB, token);
  if (!appeal || appeal.userId !== String(userId) || appeal.passedAt !== null || appeal.kickedAt !== null || appeal.until <= now) {
    return "none";
  }
  // The once-in-30-days limit guards the ordinary check, which an ad account can pass; the
  // strict check of a hold is the door itself.
  if (!appeal.challenge && (await appealsPassedSince(env.DB, appeal.userId, now - WINDOW_MS)) > 0) return "used";
  return appeal;
}

// /start <token> in the private chat: the check, or why there is none.
export async function startAppeal(env: Env, user: TelegramUser, token: string, origin: string, now: number): Promise<void> {
  const lang = pickLang(user.language_code);
  const appeal = await checkAppeal(env, token, user.id, now);
  if (typeof appeal === "string") {
    await callTelegram(env, "sendMessage", { chat_id: user.id, text: t(lang, appeal === "used" ? "appealUsed" : "appealNone") });
    return;
  }
  const chat = (await chatTitle(env.DB, appeal.chatId)) ?? "";
  await callTelegram(env, "sendMessage", {
    chat_id: user.id,
    text: t(lang, "appealDm", { chat }),
    reply_markup: { inline_keyboard: [[{ text: t(lang, "dmButton"), web_app: { url: `${origin}/?token=${token}` } }]] },
  });
}

// The check was passed: lift the mute and tell them where it happened. False if this
// appeal was already used, by a second tab or a retry.
export async function passAppeal(env: Env, appeal: Appeal, user: TelegramUser, solveMs: number | null, now: number): Promise<boolean> {
  if (!(await markAppealPassed(env.DB, appeal.token, now))) return false;
  await callTelegram(env, "restrictChatMember", {
    chat_id: appeal.chatId,
    user_id: appeal.userId,
    permissions: sendPermissions(true),
    use_independent_chat_permissions: true,
  });
  await callTelegram(env, "sendMessage", {
    chat_id: appeal.chatId,
    text: t(pickLang(user.language_code), "unmutedNotice"),
    ephemeral_message_parameters: { receiver_user_id: user.id },
  }).catch((error) => log("unmuted_notice_failed", { chat_id: appeal.chatId, error: messageOf(error) }));
  await recordEvent(env.DB, {
    chatId: appeal.chatId,
    userId: appeal.userId,
    kind: "appeal",
    detail: { rule: appeal.rule, score: appeal.score, solve_ms: solveMs, minutes_after_mute: Math.round((now - appeal.createdAt) / 60_000) },
  }, now).catch((error) => log("footprint_failed", { kind: "appeal", error: messageOf(error) }));
  log("appeal_passed", { chat_id: appeal.chatId, user_id: appeal.userId, rule: appeal.rule, score: appeal.score });
  return true;
}
