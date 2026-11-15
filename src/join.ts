// Runs join attempts: loads state, applies the pure step, saves it, then
// performs the effects. Performing an effect is the only place the guard-bot
// and DM paths differ.
import {
  type Attempt,
  type ChallengeState,
  type JoinEffect,
  type JoinEvent,
  MISS_WINDOW_MS,
  type Refusal,
  createStrictChallenge,
  intake,
  step,
} from "./attempt";
import {
  type Decision,
  type Dossier,
  type ModelVerdict,
  NEURONS,
  decideText,
  forModels,
  judgeAvatar,
  judgeText,
  modelsPaused,
} from "./classify";
import { countBans, countMisses, insertAttempt, noteChat, recordEvent, recordSpend, save, spentToday, unreachableFor, waitingDue } from "./db";
import { type Lang, pickLang, t } from "./i18n";
import { bannedWords } from "./lexicon";
import { DAILY_NEURONS, avatarFileId, profileOf } from "./moderation";
import { BAN_AT, OFFENSE_WINDOW_MS, diversionTargets, isBlocked, strong } from "./probation";
import { callTelegram, isRefused, log, messageOf } from "./telegram";
import { accountYears } from "./trajectory";
import type { ChatJoinRequest, Env, Message } from "./types";

export async function onJoinRequest(env: Env, request: ChatJoinRequest, origin: string, now: number): Promise<void> {
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
  const strict = await auditProfile(env, request, userId, chatId, bans, lols, now);
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
    challenge: strict,
  });
  const attempt = await insertAttempt(env.DB, first.attempt, lols, now);
  if (!attempt) return;
  if (attempt.status === "pending") {
    const recipient = { dmChat: request.user_chat_id, lang: pickLang(request.from.language_code) };
    await challenge(env, attempt, recipient, origin, now);
  } else {
    log("join_declined", describe(attempt));
    await perform(env, attempt, first.effects);
  }
}

// Before the check: check the profile against the keyword list, then ask the models
// about the bio (when it points somewhere) and the avatar. Any match escalates to two
// Turnstile checks and one sum; errors, timeouts or spent budget fall back to normal.
async function auditProfile(
  env: Env,
  request: ChatJoinRequest,
  userId: string,
  chatId: string,
  bans: number,
  lols: boolean | null,
  now: number,
): Promise<ChallengeState | null> {
  if (isBlocked(bans) || lols) return null;
  const profile = await profileOf(env, request.from, now, !request.bio).catch(() => null);
  const bio = request.bio || profile?.bio || null;
  const name = [request.from.first_name, request.from.last_name].filter(Boolean).join(" ");
  const personalChat = profile?.personal_chat ?? undefined;
  const lexicon = bannedWords([name, request.from.username, bio, personalChat].filter(Boolean).join(" "));
  const targets = diversionTargets({ name, bio: bio ?? undefined, channel: personalChat });
  const dossier: Dossier = {
    group: request.chat.title ?? undefined,
    name,
    username: request.from.username,
    bio: bio ?? undefined,
    personalChat,
    accountYears: Math.round(accountYears(request.from.id, now) * 10) / 10,
    kind: "none",
    edited: false,
    text: "(they are asking to join and have not posted yet)",
  };

  if (lexicon.length > 0) {
    await footprint(env, chatId, userId, "verdict", {
      on: "join_request",
      lexicon,
      targets,
      escalated: true,
      dossier,
    }, now).catch((error) => log("footprint_failed", { kind: "join_request_verdict", error: messageOf(error) }));
    return createStrictChallenge();
  }

  try {
    if (modelsPaused(now)) return null;
    const spent = await spentToday(env.DB, now);
    const hasTarget = targets.some(strong);
    const wantText = hasTarget && spent + NEURONS.decision + NEURONS.verdict <= DAILY_NEURONS;
    const avatarId = profile?.has_photo !== false ? await avatarFileId(env, request.from.id) : null;
    const textCost = wantText ? NEURONS.decision + NEURONS.verdict : 0;
    const wantAvatar = avatarId !== null && spent + textCost + NEURONS.image <= DAILY_NEURONS;
    if (!wantText && !wantAvatar) return null;

    const answer = await boundedAudit(env, dossier, wantText, wantAvatar ? avatarId : null);
    await recordSpend(env.DB, textCost + (wantAvatar ? NEURONS.image : 0), now);
    const [decision, verdict, avatar] = answer ?? [null, null, null];
    const textAd = decision !== null && decision.p >= 0.9 && verdict !== null && verdict.ad && verdict.confidence >= 0.85;
    const avatarAd = avatar !== null && avatar.ad && avatar.confidence >= 0.9;
    const escalated = textAd || avatarAd;
    await footprint(env, chatId, userId, "verdict", {
      on: "join_request",
      lexicon,
      targets,
      timed_out: answer === null,
      decision,
      text_model: verdict,
      avatar_model: avatar,
      escalated,
      dossier,
    }, now).catch((error) => log("footprint_failed", { kind: "join_request_verdict", error: messageOf(error) }));
    return escalated ? createStrictChallenge() : null;
  } catch (error) {
    log("join_audit_failed", { chat_id: chatId, user_id: userId, error: messageOf(error) });
    return null;
  }
}

// The models must never stall a webhook: after four seconds the normal check is used.
const AUDIT_TIMEOUT_MS = 4_000;

async function boundedAudit(
  env: Env,
  dossier: Dossier,
  wantText: boolean,
  avatarId: string | null,
): Promise<[Decision | null, ModelVerdict | null, ModelVerdict | null] | null> {
  let resolveTimer!: () => void;
  const timer = setTimeout(() => resolveTimer(), AUDIT_TIMEOUT_MS);
  const view = forModels(dossier);
  try {
    return await Promise.race([
      Promise.all([
        wantText ? decideText(env, view) : null,
        wantText ? judgeText(env, view) : null,
        avatarId ? judgeAvatar(env, avatarId, view) : null,
      ]),
      new Promise<null>((resolve) => {
        resolveTimer = () => resolve(null);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function footprint(
  env: Env,
  chatId: string,
  userId: string,
  kind: string,
  detail: Record<string, unknown>,
  now: number,
): Promise<void> {
  await recordEvent(env.DB, { chatId, userId, kind, detail }, now);
}

// The person pressed Start in the bot, so it may now message them: reopen every
// recent request it could not DM about and send the check. Returns how many.
export async function resumeFor(env: Env, userId: number, lang: Lang, origin: string, now: number): Promise<number> {
  let resumed = 0;
  for (const attempt of await unreachableFor(env.DB, String(userId))) {
    const outcome = await advance(env, attempt, { type: "resumed", at: now });
    if (!outcome.ok) continue;
    await challenge(env, outcome.next, { dmChat: userId, lang }, origin, now);
    log("join_resumed", describe(attempt));
    resumed += 1;
  }
  return resumed;
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
  for (const attempt of await waitingDue(env.DB, now)) {
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
    const call = answer(env, attempt, effect);
    if (effect.result === "approve") await call;
    else await call.catch((error) => log("answer_failed", { ...describe(attempt), result: effect.result, error: messageOf(error) }));
  }
}

// Where the DM goes: the join request's user_chat_id, or the private chat the person opened.
interface Recipient {
  dmChat: number;
  lang: Lang;
}

async function challenge(env: Env, attempt: Attempt, to: Recipient, origin: string, now: number): Promise<void> {
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
async function answer(env: Env, attempt: Attempt, { result, queryUsed }: JoinEffect): Promise<void> {
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
