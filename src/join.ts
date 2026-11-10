// Runs join attempts: loads state, applies the pure step, saves it, then
// performs the effects. Performing an effect is the only place the guard-bot
// and DM paths differ.
import { type Attempt, type JoinEffect, type JoinEvent, type Refusal, intake, step } from "./attempt";
import { countOffenses, insertAttempt, pendingDue, save } from "./db";
import { pickLang, t } from "./i18n";
import { OFFENSE_WINDOW_MS, isBlocked } from "./probation";
import { callTelegram, log, messageOf } from "./telegram";
import type { ChatJoinRequest, Env, Message } from "./types";

export async function onJoinRequest(env: Env, request: ChatJoinRequest, origin: string, now: number): Promise<void> {
  const userId = String(request.from.id);
  const [offenses, lols] = await Promise.all([countOffenses(env.DB, userId, now - OFFENSE_WINDOW_MS), lolsBanned(userId)]);
  const first = intake({
    chatId: String(request.chat.id),
    chatTitle: request.chat.title ?? null,
    userId,
    delivery: request.query_id
      ? { kind: "guard", queryId: request.query_id }
      : { kind: "dm", token: crypto.randomUUID().replace(/-/g, ""), messageId: null },
    blocked: isBlocked(offenses),
    lols,
    at: now,
  });
  const attempt = await insertAttempt(env.DB, first.attempt, lols, now);
  if (!attempt) return;
  if (attempt.status === "pending") {
    await challenge(env, attempt, request, origin, now);
  } else {
    log("join_declined", describe(attempt));
    await perform(env, attempt, first.effects);
  }
}

export type Outcome = { ok: false; reason: Refusal } | { ok: true; next: Attempt; error?: unknown };

// Applies an event, saves it, and performs its effects. A lost race to another
// worker reads as "closed". `error` is set when Telegram rejected an approval,
// so the caller can step the saved attempt back.
export async function advance(env: Env, attempt: Attempt, event: JoinEvent): Promise<Outcome> {
  const result = step(attempt, event);
  if (!result.ok) return result;
  if (!(await save(env.DB, attempt, result.next))) return { ok: false, reason: "closed" };
  try {
    await perform(env, result.next, result.effects);
    return { ok: true, next: result.next };
  } catch (error) {
    return { ok: true, next: result.next, error };
  }
}

export async function expirePending(env: Env, now: number): Promise<void> {
  for (const attempt of await pendingDue(env.DB, now)) {
    const result = await advance(env, attempt, { type: "tick", at: now }).catch((error) => {
      log("expire_failed", { ...describe(attempt), error: messageOf(error) });
      return null;
    });
    if (result?.ok) log("join_expired", describe(attempt));
  }
}

async function perform(env: Env, attempt: Attempt, effects: JoinEffect[]): Promise<void> {
  for (const effect of effects) {
    // An approve failure must reach the caller, which steps the attempt back.
    const call = answer(env, attempt, effect.result);
    if (effect.result === "approve") await call;
    else await call.catch((error) => log("answer_failed", { ...describe(attempt), result: effect.result, error: messageOf(error) }));
  }
}

async function challenge(env: Env, attempt: Attempt, request: ChatJoinRequest, origin: string, now: number): Promise<void> {
  try {
    let messageId: number | null = null;
    if (attempt.delivery.kind === "guard") {
      await callTelegram(env, "sendChatJoinRequestWebApp", {
        chat_join_request_query_id: attempt.delivery.queryId,
        web_app_url: `${origin}/`,
      });
    } else {
      const lang = pickLang(request.from.language_code);
      const sent = await callTelegram<Message>(env, "sendMessage", {
        chat_id: request.user_chat_id,
        text: t(lang, "dm", { chat: request.chat.title ?? "" }),
        reply_markup: {
          inline_keyboard: [[{ text: t(lang, "dmButton"), web_app: { url: `${origin}/?token=${attempt.delivery.token}` } }]],
        },
      });
      messageId = sent.message_id;
    }
    await advance(env, attempt, { type: "challenged", messageId });
    log("join_challenge", describe(attempt));
  } catch (error) {
    log("join_challenge_failed", { ...describe(attempt), error: messageOf(error) });
    await advance(env, attempt, { type: "challenge_failed", error: messageOf(error), at: now });
  }
}

// On the DM path "queue" leaves the request pending for the admins; the guard
// path tells Telegram to hand it to them.
async function answer(env: Env, attempt: Attempt, result: "approve" | "decline" | "queue"): Promise<void> {
  const delivery = attempt.delivery;
  if (delivery.kind === "guard") {
    await callTelegram(env, "answerChatJoinRequestQuery", { chat_join_request_query_id: delivery.queryId, result });
    return;
  }
  if (result !== "queue") {
    await callTelegram(env, result === "approve" ? "approveChatJoinRequest" : "declineChatJoinRequest", {
      chat_id: attempt.chatId,
      user_id: attempt.userId,
    });
  }
  if (delivery.messageId) {
    await callTelegram(env, "deleteMessage", { chat_id: attempt.userId, message_id: delivery.messageId }).catch(() => {});
  }
}

// Shared spam list (https://lols.bot, free, no key). Fails open: an outage must not block real people.
async function lolsBanned(userId: string): Promise<boolean | null> {
  try {
    const response = await fetch(`https://api.lols.bot/account?id=${userId}`, { signal: AbortSignal.timeout(2_000) });
    const body = (await response.json()) as { ok?: boolean; banned?: boolean };
    return body.ok ? body.banned === true : null;
  } catch {
    return null;
  }
}

function describe(attempt: Attempt) {
  return { chat_id: attempt.chatId, user_id: attempt.userId, delivery: attempt.delivery.kind };
}
