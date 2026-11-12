// Watches groups: who joins and how, what newcomers post and edit, and what the
// detectors conclude. Deterministic rules act at once; model and keyword
// judgements run in the background and are only recorded (shadow mode) until the
// benchmark shows how often they would hit real people. Every step leaves a
// footprint in `events`.
import { type ModelVerdict, judgeImage, judgeText } from "./classify";
import {
  chatsJoinedSince,
  countOffenses,
  countProbationMessage,
  insertOffense,
  labelMember,
  latestProfile,
  prune,
  recordEvent,
  recordJoin,
  seenElsewhere,
} from "./db";
import { pickLang, t } from "./i18n";
import { chatWords, profileWords } from "./lexicon";
import {
  DUPLICATE_WINDOW_MS,
  OFFENSE_WINDOW_MS,
  PROBATION_MESSAGES,
  PROBATION_MS,
  contentHash,
  hasLinkButton,
  isBlocked,
  judge,
  messageText,
  spamReason,
} from "./probation";
import { callTelegram, log, messageOf } from "./telegram";
import type { ChatMemberUpdated, Env, Message, TelegramUser } from "./types";

const FOOTPRINT_MS = 14 * 24 * 60 * 60 * 1000;
const EXCERPT = 500;

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

export interface Context {
  now: number;
  edited: boolean;
  background: (work: Promise<unknown>) => void; // runs after the webhook has answered
}

// ---------- membership ----------

export async function onMemberUpdate(env: Env, update: ChatMemberUpdated, ctx: Context): Promise<void> {
  const user = update.new_chat_member.user;
  const chatId = String(update.chat.id);
  const userId = String(user.id);
  const before = update.old_chat_member.status;
  const after = update.new_chat_member.status;

  if ((after === "member" || after === "restricted") && (before === "left" || before === "kicked")) {
    if (user.is_bot) return;
    await recordJoin(env.DB, chatId, userId, ctx.now);
    const approvedBy = update.from.id !== user.id ? who(update.from) : undefined;
    await footprint(env, chatId, userId, "join", {
      ...person(user),
      approved_by: approvedBy,
      via_join_request: update.via_join_request ?? false,
      invite_link: update.invite_link?.name,
      invite_link_creator: update.invite_link?.creator ? who(update.invite_link.creator) : undefined,
    }, ctx.now);
    ctx.background(screenProfile(env, chatId, user, approvedBy, ctx.now));
    return;
  }
  if (after === "left" || after === "kicked") {
    await labelMember(env.DB, chatId, userId, after === "kicked" ? "banned" : "left", ctx.now);
    await footprint(env, chatId, userId, "leave", { status: after, by: update.from.id !== user.id ? who(update.from) : "self" }, ctx.now);
  }
}

// Bio, profile channel and photo: where "say nothing, the profile is the ad" accounts advertise.
async function screenProfile(env: Env, chatId: string, user: TelegramUser, approvedBy: string | undefined, now: number) {
  const info = await callTelegram<{ bio?: string; personal_chat?: { title?: string; username?: string }; photo?: unknown }>(
    env,
    "getChat",
    { chat_id: user.id },
  ).catch((error) => ({ error: messageOf(error) }) as { error: string });
  const profile = "error" in info
    ? { error: info.error, approved_by: approvedBy }
    : {
        bio: info.bio,
        personal_chat: info.personal_chat ? `${info.personal_chat.title ?? ""} @${info.personal_chat.username ?? ""}` : undefined,
        has_photo: Boolean(info.photo),
        approved_by: approvedBy,
      };
  await footprint(env, chatId, String(user.id), "profile", profile, now);
  const name = displayName(user);
  const words = profileWords([name, user.username, "bio" in profile ? profile.bio : "", "personal_chat" in profile ? profile.personal_chat : ""].filter(Boolean).join(" "));
  const model = await judgeText(env, {
    name,
    username: user.username,
    bio: "bio" in profile ? profile.bio : undefined,
    personalChat: "personal_chat" in profile ? profile.personal_chat : undefined,
    approvedBy,
    minutesSinceJoin: 0,
    index: 0,
    edited: false,
    text: "(just joined, no message yet)",
  });
  await footprint(env, chatId, String(user.id), "verdict", { on: "profile", lexicon: words, model }, Date.now());
}

// ---------- messages ----------

export async function onGroupMessage(env: Env, message: Message, ctx: Context): Promise<void> {
  const chatId = String(message.chat.id);

  // Posted on behalf of a chat: the group itself (anonymous admins), its linked channel, or another channel.
  if (message.sender_chat) {
    if (message.sender_chat.id === message.chat.id || message.is_automatic_forward || !hasLinkButton(message)) return;
    await remove(env, message, ctx, String(message.sender_chat.id), "link_button_channel", async () => {
      await act(env, "banChatSenderChat", { chat_id: chatId, sender_chat_id: message.sender_chat!.id });
    });
    return;
  }

  const from = message.from;
  if (!from) return;
  const userId = String(from.id);

  if (from.is_bot) {
    if (from.id === botId(env) || !hasLinkButton(message) || (await isAdmin(env, chatId, from.id))) return;
    await remove(env, message, ctx, userId, "link_button_bot", async () => {
      await act(env, "banChatMember", { chat_id: chatId, user_id: from.id, revoke_messages: true });
    });
    return;
  }

  const probation = await countProbationMessage(env.DB, chatId, userId, ctx.now - PROBATION_MS, PROBATION_MESSAGES);

  if (!probation) {
    // An established member posting a link button is a compromised or sleeper account.
    if (!hasLinkButton(message) || (await isAdmin(env, chatId, from.id))) return;
    await insertOffense(env.DB, userId, chatId, "link_button", ctx.now);
    const blocked = isBlocked(await countOffenses(env.DB, userId, ctx.now - OFFENSE_WINDOW_MS));
    await remove(env, message, ctx, userId, "link_button_member", async () => {
      if (blocked) await act(env, "banChatMember", { chat_id: chatId, user_id: from.id, revoke_messages: true });
    });
    return;
  }

  const text = messageText(message);
  await footprint(env, chatId, userId, ctx.edited ? "edit" : "message", {
    index: probation.index,
    minutes_since_join: Math.round((ctx.now - probation.joinedAt) / 60_000),
    name: displayName(from),
    text: text.slice(0, EXCERPT),
    photo: Boolean(message.photo?.length),
    link_button: hasLinkButton(message),
    via_bot: message.via_bot?.username,
    forward: Boolean(message.forward_origin),
  }, ctx.now);

  const enforced = await enforceRules(env, message, from, probation.joinedAt, ctx);
  ctx.background(shadow(env, message, from, probation, ctx, enforced));
}

// Deterministic rules for newcomers; returns what was done, for the footprint.
async function enforceRules(env: Env, message: Message, from: TelegramUser, joinedAt: number, ctx: Context) {
  const chatId = String(message.chat.id);
  const userId = String(from.id);
  const reason = spamReason(message);
  const hash = reason ? null : await contentHash(messageText(message));
  const duplicateElsewhere = hash
    ? await seenElsewhere(env.DB, userId, chatId, hash, ctx.now - DUPLICATE_WINDOW_MS, ctx.now)
    : false;
  if (!reason && !duplicateElsewhere) return null;

  const priorOffenses = await countOffenses(env.DB, userId, ctx.now - OFFENSE_WINDOW_MS);
  const verdict = judge({ reason, duplicateElsewhere, priorOffenses, approvedAt: joinedAt });
  if (verdict.action === "allow") return null;

  await insertOffense(env.DB, userId, chatId, verdict.reason, ctx.now);
  await act(env, "deleteMessage", { chat_id: chatId, message_id: message.message_id });
  if (verdict.action === "mute") {
    const until = Math.floor(verdict.until / 1000);
    await act(env, "restrictChatMember", {
      chat_id: chatId,
      user_id: userId,
      permissions: MUTED,
      use_independent_chat_permissions: true,
      until_date: until,
    });
    // Tell only them why and until when; a real newcomer should not be left guessing.
    // Telegram shows the time in their own time zone; the text inside is the fallback.
    const fallback = `${new Date(verdict.until).toISOString().slice(0, 16).replace("T", " ")} UTC`;
    await act(env, "sendMessage", {
      chat_id: chatId,
      text: t(pickLang(from.language_code), "muted", { time: `<tg-time unix="${until}" format="dt">${fallback}</tg-time>` }),
      parse_mode: "HTML",
      ephemeral_message_parameters: { receiver_user_id: from.id },
    });
  } else {
    // Ban the account wherever it is still new, removing its messages there too.
    for (const chat of await chatsJoinedSince(env.DB, userId, ctx.now - PROBATION_MS)) {
      await act(env, "banChatMember", { chat_id: chat, user_id: userId, revoke_messages: true });
    }
  }
  const done = { rule: verdict.reason, action: verdict.action };
  await footprint(env, chatId, userId, "action", done, ctx.now);
  log(verdict.action === "mute" ? "spam_muted" : "spam_blocked", { chat_id: chatId, user_id: userId, reason: verdict.reason });
  return done;
}

// Every detector's opinion on this message, recorded for the benchmark; none of it acts.
async function shadow(
  env: Env,
  message: Message,
  from: TelegramUser,
  probation: { joinedAt: number; index: number },
  ctx: Context,
  enforced: { rule: string; action: string } | null,
) {
  const chatId = String(message.chat.id);
  const userId = String(from.id);
  const text = messageText(message);
  const profile = await latestProfile(env.DB, chatId, userId);
  const subject = {
    name: displayName(from),
    username: from.username,
    bio: profile?.bio,
    personalChat: profile?.personal_chat,
    approvedBy: profile?.approved_by,
    minutesSinceJoin: Math.round((ctx.now - probation.joinedAt) / 60_000),
    index: probation.index,
    edited: ctx.edited,
    text,
  };
  const photo = message.photo?.length ? largestUnder(message.photo, 1280) : undefined;
  const [textModel, imageModel]: (ModelVerdict | null)[] = await Promise.all([
    text || subject.name ? judgeText(env, subject) : null,
    photo ? judgeImage(env, photo, subject) : null,
  ]);
  await footprint(env, chatId, userId, "verdict", {
    on: ctx.edited ? "edit" : "message",
    index: probation.index,
    rules: spamReason(message),
    enforced,
    lexicon: { text: chatWords(text), name: profileWords(subject.name) },
    text_model: textModel,
    image_model: imageModel,
  }, Date.now());
}

// ---------- helpers ----------

async function remove(env: Env, message: Message, ctx: Context, actor: string, rule: string, then: () => Promise<void>) {
  const chatId = String(message.chat.id);
  await act(env, "deleteMessage", { chat_id: chatId, message_id: message.message_id });
  await then();
  await footprint(env, chatId, actor, "action", {
    rule,
    text: messageText(message).slice(0, EXCERPT),
    buttons: message.reply_markup?.inline_keyboard?.flat().map((b) => `${b.text ?? ""} ${b.url ?? ""}`.trim()),
    name: message.sender_chat?.title ?? (message.from ? displayName(message.from) : undefined),
  }, ctx.now);
  log("ad_removed", { chat_id: chatId, actor, rule });
}

async function footprint(env: Env, chatId: string, userId: string, kind: string, detail: Record<string, unknown>, now: number) {
  await recordEvent(env.DB, { chatId, userId, kind, detail }, now).catch((error) =>
    log("footprint_failed", { kind, error: messageOf(error) }),
  );
}

const admins = new Map<string, { admin: boolean; until: number }>();

async function isAdmin(env: Env, chatId: string, userId: number): Promise<boolean> {
  const key = `${chatId}:${userId}`;
  const cached = admins.get(key);
  if (cached && cached.until > Date.now()) return cached.admin;
  const member = await callTelegram<{ status: string }>(env, "getChatMember", { chat_id: chatId, user_id: userId }).catch(
    () => ({ status: "unknown" }),
  );
  const admin = member.status === "creator" || member.status === "administrator";
  admins.set(key, { admin, until: Date.now() + 10 * 60 * 1000 });
  return admin;
}

// The bot's own id is the number before the colon in its token.
function botId(env: Env): number {
  return Number(env.TELEGRAM_BOT_TOKEN.split(":")[0]);
}

function displayName(user: TelegramUser): string {
  return [user.first_name, user.last_name].filter(Boolean).join(" ");
}

function person(user: TelegramUser) {
  return { name: displayName(user), username: user.username, premium: user.is_premium ?? false, lang: user.language_code };
}

function who(user: TelegramUser): string {
  return `${user.is_bot ? "bot" : "user"}:${user.username ? `@${user.username}` : user.id}`;
}

function largestUnder(sizes: { file_id: string; width: number }[], maxWidth: number): string {
  const fitting = sizes.filter((s) => s.width <= maxWidth);
  return (fitting.at(-1) ?? sizes[0]).file_id;
}

// Moderation calls are best effort: a missing admin right must not stop the rest.
async function act(env: Env, method: string, params: Record<string, unknown>): Promise<void> {
  await callTelegram(env, method, params).catch((error) =>
    log(`${method}_failed`, { chat_id: params.chat_id, error: messageOf(error) }),
  );
}

export async function pruneModeration(env: Env, now: number): Promise<void> {
  await prune(env.DB, {
    hashes: now - DUPLICATE_WINDOW_MS,
    offenses: now - OFFENSE_WINDOW_MS,
    newcomers: now - 7 * 24 * 60 * 60 * 1000,
    events: now - FOOTPRINT_MS,
  });
}
