// Runs join attempts: loads state, applies the pure step, saves it, then
// performs the effects. Performing an effect is the only place the guard-bot
// and DM paths differ.
import {
  AD_REPEAT_MS,
  type Attempt,
  type JoinEffect,
  type JoinEvent,
  MISS_WINDOW_MS,
  type Refusal,
  type Screening,
  createStrictChallenge,
  intake,
  step,
} from "./attempt";
import type { Dossier } from "./classify";
import {
  countBans,
  countMisses,
  insertAttempt,
  noteChat,
  recordEvent,
  recordTurnedAway,
  save,
  turnedAwaySince,
  unreachableFor,
  waitingDue,
} from "./db";
import { type Lang, pickLang, t } from "./i18n";
import { avatarFileId, profileOf } from "./moderation";
import { BAN_AT, OFFENSE_WINDOW_MS, isBlocked } from "./probation";
import { auditProfile, type ProfileAudit } from "./screen";
import { callTelegram, isRefused, log, messageOf } from "./telegram";
import { accountYears } from "./trajectory";
import type { ChatJoinRequest, Env, Message } from "./types";

// Where the DM goes: the join request's user_chat_id, or the private chat the person opened.
interface Recipient {
  dmChat: number;
  lang: Lang;
}

// What performing a "challenge" or "notify_ad" effect needs; absent where neither can occur.
interface Reach {
  to: Recipient;
  origin: string;
}

// A join request: declined at the door, or screened in the background (`background` runs
// after the webhook has answered), then declined as an ad or sent the check.
export async function onJoinRequest(
  env: Env,
  request: ChatJoinRequest,
  origin: string,
  now: number,
  background: (work: Promise<unknown>) => void,
): Promise<void> {
  const userId = String(request.from.id);
  const chatId = String(request.chat.id);
  const { title, username, type } = request.chat;
  await noteChat(env.DB, chatId, { title: title ?? null, username: username ?? null, type: type ?? null }, now);
  await recordEvent(env.DB, {
    chatId,
    userId,
    kind: "join_request",
    detail: {
      guard_query: Boolean(request.query_id), // false even in guard-bot groups as of 2026-11-11
      bio: request.bio,
      name: [request.from.first_name, request.from.last_name].filter(Boolean).join(" "),
      username: request.from.username,
    },
  }, now).catch((error) => log("footprint_failed", { kind: "join_request", error: messageOf(error) }));
  const [bans, lols, misses] = await Promise.all([
    countBans(env.DB, userId, now - OFFENSE_WINDOW_MS, BAN_AT),
    lolsBanned(userId),
    countMisses(env.DB, chatId, userId, now - MISS_WINDOW_MS),
  ]);
  const first = intake({
    chatId,
    chatTitle: request.chat.title ?? null,
    userId,
    delivery: request.query_id
      ? { kind: "guard", queryId: request.query_id }
      : { kind: "dm", token: crypto.randomUUID().replace(/-/g, ""), messageId: null },
    blocked: isBlocked(bans),
    lols,
    misses,
    at: now,
  });
  const attempt = await insertAttempt(env.DB, first.attempt, lols, now);
  if (!attempt) return;
  if (attempt.status !== "screening") {
    log("join_declined", describe(attempt));
    await perform(env, attempt, first.effects);
    return;
  }
  const reach = { to: { dmChat: request.user_chat_id, lang: pickLang(request.from.language_code) }, origin };
  background(screen(env, attempt, request, reach, now));
}

// Audits the requester's profile and moves the attempt on. Any failure is "unknown", which
// gets the strict check: a request is never let through on the ordinary check unread.
async function screen(env: Env, attempt: Attempt, request: ChatJoinRequest, reach: Reach, now: number): Promise<void> {
  const { chatId, userId } = attempt;
  const name = [request.from.first_name, request.from.last_name].filter(Boolean).join(" ");
  let dossier: Dossier = { group: attempt.chatTitle ?? undefined, name, username: request.from.username, bio: request.bio, kind: "none", edited: false, text: "(they are asking to join and have not posted yet)" };
  let audit: ProfileAudit | null = null;
  try {
    const profile = await profileOf(env, request.from, now, !request.bio).catch(() => null);
    dossier = {
      ...dossier,
      bio: request.bio || profile?.bio || undefined,
      personalChat: profile?.personal_chat ?? undefined,
      accountYears: Math.round(accountYears(request.from.id, now) * 10) / 10,
    };
    const avatarId = profile?.has_photo !== false ? await avatarFileId(env, request.from.id) : null;
    audit = await auditProfile(env, dossier, avatarId, now);
  } catch (error) {
    log("join_audit_failed", { chat_id: chatId, user_id: userId, error: messageOf(error) });
  }
  const verdict: Screening = audit?.verdict ?? "unknown";
  const repeat = verdict === "ad" && (await turnedAwaySince(env.DB, chatId, userId, now - AD_REPEAT_MS));
  const at = Date.now();
  const outcome = await advance(env, attempt, { type: "screened", verdict, repeat, strict: createStrictChallenge(), at }, reach);
  if (outcome.ok && outcome.next.status === "declined") await recordTurnedAway(env.DB, chatId, userId, "request", at);
  await recordEvent(env.DB, {
    chatId,
    userId,
    kind: "verdict",
    detail: { on: "join_request", ...(audit ?? { verdict, failed: true }), skipped: audit?.decision || audit?.text_model || audit?.avatar_model ? undefined : "no_model", repeat, outcome: outcome.ok ? outcome.next.status : outcome.reason, dossier },
  }, at).catch((error) => log("footprint_failed", { kind: "join_request_verdict", error: messageOf(error) }));
  log("join_screened", { ...describe(attempt), verdict, repeat });
}

// The person pressed Start in the bot, so it may now message them: reopen every
// recent request it could not DM about and send the check. Returns how many.
export async function resumeFor(env: Env, userId: number, lang: Lang, origin: string, now: number): Promise<number> {
  let resumed = 0;
  for (const attempt of await unreachableFor(env.DB, String(userId))) {
    const outcome = await advance(env, attempt, { type: "resumed", at: now });
    if (!outcome.ok) continue;
    await challenge(env, outcome.next, { to: { dmChat: userId, lang }, origin }, now);
    log("join_resumed", describe(attempt));
    resumed += 1;
  }
  return resumed;
}

export type Outcome = { ok: false; reason: Refusal } | { ok: true; next: Attempt; error?: unknown };

// Applies an event, saves it, and performs its effects. A lost race to another
// worker reads as "closed". `error` is set when Telegram rejected an approval,
// so the caller can step the saved attempt back.
export async function advance(env: Env, attempt: Attempt, event: JoinEvent, reach?: Reach): Promise<Outcome> {
  const result = step(attempt, event);
  if (!result.ok) return result;
  if (!(await save(env.DB, attempt, result.next))) return { ok: false, reason: "closed" };
  try {
    await perform(env, result.next, result.effects, reach);
    return { ok: true, next: result.next };
  } catch (error) {
    return { ok: true, next: result.next, error };
  }
}

export async function expirePending(env: Env, now: number): Promise<void> {
  for (const attempt of await waitingDue(env.DB, now)) {
    const result = await advance(env, attempt, { type: "tick", at: now }).catch((error) => {
      log("expire_failed", { ...describe(attempt), error: messageOf(error) });
      return null;
    });
    if (result?.ok) log("join_expired", describe(attempt));
  }
}

async function perform(env: Env, attempt: Attempt, effects: JoinEffect[], reach?: Reach): Promise<void> {
  for (const effect of effects) {
    if (effect.type === "challenge") {
      if (reach) await challenge(env, attempt, reach, Date.now());
      else log("challenge_unreachable", describe(attempt));
      continue;
    }
    if (effect.type === "notify_ad") {
      if (reach) await notifyAd(env, attempt, reach.to);
      continue;
    }
    // An approve failure must reach the caller, which steps the attempt back.
    const call = answer(env, attempt, effect);
    if (effect.result === "approve") await call;
    else await call.catch((error) => log("answer_failed", { ...describe(attempt), result: effect.result, error: messageOf(error) }));
  }
}

// Why they were turned away and that asking again gets the strict check. Best effort: the
// person may have closed their DMs, and the decline must go out regardless.
async function notifyAd(env: Env, attempt: Attempt, to: Recipient): Promise<void> {
  await callTelegram(env, "sendMessage", { chat_id: to.dmChat, text: t(to.lang, "adDeclined", { chat: attempt.chatTitle ?? "" }) }).catch(
    (error) => log("ad_notice_failed", { ...describe(attempt), error: messageOf(error) }),
  );
}

async function challenge(env: Env, attempt: Attempt, { to, origin }: Reach, now: number): Promise<void> {
  try {
    let messageId: number | null = null;
    if (attempt.delivery.kind === "guard") {
      await callTelegram(env, "sendChatJoinRequestWebApp", {
        chat_join_request_query_id: attempt.delivery.queryId,
        web_app_url: `${origin}/`,
      });
    } else {
      const sent = await callTelegram<Message>(env, "sendMessage", {
        chat_id: to.dmChat,
        text: t(to.lang, "dm", { chat: attempt.chatTitle ?? "" }),
        reply_markup: {
          inline_keyboard: [
            [{ text: t(to.lang, "dmButton"), web_app: { url: `${origin}/?token=${attempt.delivery.token}` } }],
          ],
        },
      });
      messageId = sent.message_id;
    }
    await advance(env, attempt, { type: "challenged", messageId });
    log("join_challenge", describe(attempt));
  } catch (error) {
    const refused = isRefused(error);
    log("join_challenge_failed", { ...describe(attempt), refused, error: messageOf(error) });
    await advance(env, attempt, { type: "challenge_failed", error: messageOf(error), refused, at: now });
  }
}

// On the DM path "queue" leaves the request pending for the admins; the guard
// path tells Telegram to hand it to them, after which the query is spent and
// the request is answered like any other.
async function answer(env: Env, attempt: Attempt, { result, queryUsed }: Extract<JoinEffect, { type: "answer" }>): Promise<void> {
  const delivery = attempt.delivery;
  if (delivery.kind === "guard" && !queryUsed) {
    await callTelegram(env, "answerChatJoinRequestQuery", { chat_join_request_query_id: delivery.queryId, result });
    return;
  }
  if (result !== "queue") {
    await callTelegram(env, result === "approve" ? "approveChatJoinRequest" : "declineChatJoinRequest", {
      chat_id: attempt.chatId,
      user_id: attempt.userId,
    });
  }
  if (delivery.kind === "dm" && delivery.messageId) {
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
