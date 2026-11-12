// Watches groups by behaviour. Every person's activity updates a sketch of how they
// behave across Kitan groups (trajectory.ts). Newcomers are always reviewed; anyone
// else is left alone once active and not anomalous (needsReview). Review means the
// deterministic rules act at once while keyword and model judgements run in the
// background and are only recorded (shadow mode). Reviewed people leave footprints in
// `events`; people left alone are not recorded.
import { decideText, judgeImage, judgeText } from "./classify";
import {
  chatsJoinedSince,
  countOffenses,
  countingSince,
  insertOffense,
  labelMember,
  latestProfile,
  loadForest,
  modelAge,
  prune,
  readStanding,
  readTrajectory,
  recordEvent,
  recordJoin,
  saveForest,
  seenElsewhere,
  trainingSketches,
  writeStanding,
} from "./db";
import { pickLang, t } from "./i18n";
import { score, train } from "./iforest";
import { chatWords, profileWords } from "./lexicon";
import {
  ACTIVE_AFTER,
  DUPLICATE_WINDOW_MS,
  OFFENSE_WINDOW_MS,
  type Review,
  contentHash,
  hasLinkButton,
  judge,
  messageText,
  needsReview,
  spamReason,
} from "./probation";
import { callTelegram, log, messageOf } from "./telegram";
import { type Trajectory, features, step } from "./trajectory";
import type { ChatMemberUpdated, Env, Message, TelegramUser } from "./types";

const FOOTPRINT_MS = 14 * 24 * 60 * 60 * 1000;
const EXCERPT = 500;
// Telegram's mid photo size: same verdicts as 1280 px in bench/, at a quarter of the cost.
const IMAGE_PX = 320;
// The written verdict costs ~3x the yes/no decision, so it runs where the decision leans
// towards an ad, where a rule fired, and on a random share kept for comparison.
const VERDICT_FROM_P = 0.2;
const VERDICT_SAMPLE = 0.1;
// Isolation forest: 50 trees of 128 rows trains in ~5 ms, within a free-plan cron's CPU.
const FOREST = { trees: 50, sample: 128, rows: 1000, everyMs: 24 * 60 * 60 * 1000 };

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
    const trajectory = step(await readTrajectory(env.DB, userId), { kind: "join", at: ctx.now });
    await recordJoin(env.DB, chatId, userId, trajectory, ctx.now);
    const approvedBy = update.from.id !== user.id ? who(update.from) : undefined;
    await footprint(env, chatId, userId, "join", {
      ...person(user),
      approved_by: approvedBy,
      via_join_request: update.via_join_request ?? false,
      invite_link: update.invite_link?.name,
      invite_link_creator: update.invite_link?.creator ? who(update.invite_link.creator) : undefined,
      groups_joined: trajectory.joins,
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
  const about = ["bio" in profile ? profile.bio : "", "personal_chat" in profile ? profile.personal_chat : ""].filter(Boolean);
  const decision = await decideText(env, {
    name,
    minutesSinceJoin: 0,
    index: 0,
    edited: false,
    text: about.length ? `(profile) ${about.join(" / ")}` : "(profile is empty)",
  });
  await footprint(env, chatId, String(user.id), "verdict", {
    on: "profile",
    lexicon: profileWords([name, user.username, ...about].filter(Boolean).join(" ")),
    decision,
  }, Date.now());
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

  // Every person's activity updates their sketch, so a regular whose behaviour turns can be noticed.
  const standing = await readStanding(env.DB, chatId, userId);
  const trajectory = step(standing.trajectory, activity(message, ctx, !standing.known));
  await writeStanding(env.DB, chatId, userId, trajectory, !standing.known && !ctx.edited, ctx.now);

  const mayBeLeftAlone = trajectory.messages > ACTIVE_AFTER || standing.joinedAt === null;
  const anomaly = mayBeLeftAlone ? await anomalyScore(env, trajectory, from.id, ctx.now) : null;
  const review = needsReview(
    { joinedAt: standing.joinedAt, messages: trajectory.messages, firstAt: trajectory.firstAt, anomaly },
    await countingSince(env.DB),
    ctx.now,
  );
  if (!review.review) return;

  await footprint(env, chatId, userId, ctx.edited ? "edit" : "message", {
    review: review.why,
    anomaly,
    messages: trajectory.messages,
    minutes_since_join: standing.joinedAt === null ? null : Math.round((ctx.now - standing.joinedAt) / 60_000),
    name: displayName(from),
    username: from.username,
    // Everything the rules read, so the rules can be replayed exactly.
    facts: messageFacts(message),
  }, ctx.now);

  const enforced = await enforceRules(env, message, from, ctx);
  ctx.background(shadow(env, message, from, standing.joinedAt, trajectory, review, ctx, enforced));
}

function activity(message: Message, ctx: Context, newChat: boolean) {
  if (ctx.edited) return { kind: "edit" as const, at: ctx.now };
  const text = messageText(message);
  const entities = [...(message.entities ?? []), ...(message.caption_entities ?? [])];
  return {
    kind: "message" as const,
    at: ctx.now,
    newChat,
    link: hasLinkButton(message) || entities.some((e) => e.type === "url" || e.type === "text_link") || /https?:\/\/|t\.me\//i.test(text),
    mention: entities.some((e) => e.type === "mention" || e.type === "text_mention") || /@[a-z0-9_]{3,}/i.test(text),
    forward: Boolean(message.forward_origin),
    media: Boolean(message.photo?.length),
    chars: text.length,
  };
}

async function anomalyScore(env: Env, trajectory: Trajectory, userId: number, now: number): Promise<number | null> {
  const forest = await loadForest(env.DB, now);
  return forest ? Math.round(score(forest, features(trajectory, userId, now)) * 1000) / 1000 : null;
}

// Deterministic rules for people under review; returns what was done, for the footprint.
async function enforceRules(env: Env, message: Message, from: TelegramUser, ctx: Context) {
  const chatId = String(message.chat.id);
  const userId = String(from.id);
  const reason = spamReason(message);
  const hash = reason ? null : await contentHash(messageText(message));
  const duplicateElsewhere = hash
    ? await seenElsewhere(env.DB, userId, chatId, hash, ctx.now - DUPLICATE_WINDOW_MS, ctx.now)
    : false;
  if (!reason && !duplicateElsewhere) return null;

  const priorOffenses = await countOffenses(env.DB, userId, ctx.now - OFFENSE_WINDOW_MS);
  const verdict = judge({ reason, duplicateElsewhere, priorOffenses, now: ctx.now });
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
    for (const chat of await chatsJoinedSince(env.DB, userId, ctx.now - 7 * 24 * 60 * 60 * 1000)) {
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
  joinedAt: number | null,
  trajectory: Trajectory,
  review: Review,
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
    minutesSinceJoin: joinedAt === null ? 0 : Math.round((ctx.now - joinedAt) / 60_000),
    index: trajectory.messages,
    edited: ctx.edited,
    text,
  };
  const photo = message.photo?.length ? largestUnder(message.photo, IMAGE_PX) : undefined;
  const hasText = Boolean(text || subject.name);
  const [decision, imageModel] = await Promise.all([
    hasText ? decideText(env, subject) : null,
    photo ? judgeImage(env, photo.file_id, subject) : null,
  ]);
  const sampled = Math.random() < VERDICT_SAMPLE;
  const worthWriting = hasText && (decision === null || decision.p >= VERDICT_FROM_P || enforced !== null || sampled);
  const textModel = worthWriting ? await judgeText(env, subject) : null;
  await footprint(env, chatId, userId, "verdict", {
    on: ctx.edited ? "edit" : "message",
    review: review.why,
    rules: spamReason(message),
    enforced,
    lexicon: { text: chatWords(text), name: profileWords(subject.name) },
    decision,
    text_model: textModel,
    text_model_sampled: worthWriting && sampled && (decision?.p ?? 1) < VERDICT_FROM_P && enforced === null,
    image_model: imageModel ? { ...imageModel, px: photo?.width } : null,
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

// Telegram keeps each photo at several sizes; the model reads the largest within the limit.
function largestUnder<T extends { width: number }>(sizes: T[], maxWidth: number): T {
  const fitting = sizes.filter((s) => s.width <= maxWidth);
  return fitting.at(-1) ?? sizes[0];
}

// Exactly the parts of a message the rules read; stored so replay can run them again.
function messageFacts(message: Message): Partial<Message> {
  return {
    text: message.text?.slice(0, EXCERPT),
    caption: message.caption?.slice(0, EXCERPT),
    entities: message.entities?.map((e) => ({ type: e.type })),
    caption_entities: message.caption_entities?.map((e) => ({ type: e.type })),
    forward_origin: message.forward_origin ? true : undefined,
    external_reply: message.external_reply ? true : undefined,
    story: message.story ? true : undefined,
    via_bot: message.via_bot ? { username: message.via_bot.username } : undefined,
    reply_markup: message.reply_markup,
    photo: message.photo?.map((p) => ({ file_id: p.file_id, width: p.width, height: p.height })),
  };
}

// Moderation calls are best effort: a missing admin right must not stop the rest.
async function act(env: Env, method: string, params: Record<string, unknown>): Promise<void> {
  await callTelegram(env, method, params).catch((error) =>
    log(`${method}_failed`, { chat_id: params.chat_id, error: messageOf(error) }),
  );
}

// ---------- housekeeping (hourly) ----------

// Retrains the isolation forest once a day on active accounts, the population whose
// behaviour counts as ordinary, and prunes expired rows.
export async function hourly(env: Env, now: number): Promise<void> {
  if ((await modelAge(env.DB, now)) >= FOREST.everyMs) {
    const sketches = await trainingSketches(env.DB, ACTIVE_AFTER, FOREST.rows);
    if (sketches.length >= FOREST.sample) {
      const rows = sketches.map((s) => features(s.trajectory, s.userId, now));
      await saveForest(env.DB, train(rows, { trees: FOREST.trees, sample: FOREST.sample, seed: Math.floor(now / 86_400_000) }), rows.length, now);
      log("forest_trained", { rows: rows.length });
    }
  }
  await prune(env.DB, {
    hashes: now - DUPLICATE_WINDOW_MS,
    offenses: now - OFFENSE_WINDOW_MS,
    events: now - FOOTPRINT_MS,
  });
}
