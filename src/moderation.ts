// Watches groups by behaviour. Every person's activity updates a sketch of how they
// behave across Kitan groups (trajectory.ts). Newcomers are always reviewed; anyone
// else is left alone once active and not anomalous (needsReview). Review means the
// deterministic rules act at once while keyword and model judgements run in the
// background and are only recorded (shadow mode). Reviewed people leave footprints in
// `events`; people left alone are not recorded.
import { type Dossier, NEURONS, decideText, forModels, judgeImage, judgeText, modelsPaused } from "./classify";
import {
  type Profile,
  chatTitle,
  chatsJoinedSince,
  countOffenses,
  countingSince,
  creditReply,
  earlierCopies,
  insertOffense,
  labelMember,
  latestJoin,
  loadForest,
  noteChat,
  judgedSince,
  readProfile,
  recordSpend,
  spentToday,
  writeProfile,
  modelAge,
  prune,
  readStanding,
  readTrajectory,
  recordEvent,
  recordJoin,
  saveForest,
  trainingSketches,
  writeStanding,
} from "./db";
import { pickLang, t } from "./i18n";
import { score, train } from "./iforest";
import { bannedWords, chatWords, profileWords } from "./lexicon";
import {
  ACTIVE_AFTER,
  NEWCOMER_MS,
  type Target,
  DUPLICATE_WINDOW_MS,
  MIN_DUPLICATE_LENGTH,
  OFFENSE_WINDOW_MS,
  REPEAT_AT,
  type Review,
  contentHash,
  hasLinkButton,
  judge,
  messageKind,
  messageText,
  needsReview,
  sameness,
  diversionTargets,
  spamReason,
  strong,
} from "./probation";
import { callTelegram, log, messageOf } from "./telegram";
import { type Trajectory, accountYears, features, social, step } from "./trajectory";
import type { ChatMemberUpdated, Env, Message, PhotoSize, TelegramChat, TelegramUser } from "./types";

// A profile read from Telegram is reused for a week; spam accounts do change their bio.
const PROFILE_MS = 7 * 24 * 60 * 60 * 1000;

const FOOTPRINT_MS = 14 * 24 * 60 * 60 * 1000;
const EXCERPT = 500;
// Telegram's mid photo size: same verdicts as 1280 px in bench/, at a quarter of the cost.
const IMAGE_PX = 320;
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
  ctx.background(rememberChat(env, update.chat, ctx.now));

  if ((after === "member" || after === "restricted") && (before === "left" || before === "kicked")) {
    if (user.is_bot) return;
    const trajectory = step(await readTrajectory(env.DB, userId), { kind: "join", at: ctx.now });
    await recordJoin(env.DB, chatId, userId, trajectory, ctx.now);
    const approvedBy = update.from.id !== user.id ? who(update.from) : undefined;
    await footprint(env, chatId, userId, "join", {
      ...person(user),
      approved_by: approvedBy,
      by_kitan: update.from.id === botId(env),
      via_join_request: update.via_join_request ?? false,
      invite_link: update.invite_link?.name,
      invite_link_creator: update.invite_link?.creator ? who(update.invite_link.creator) : undefined,
      groups_joined: trajectory.joins,
    }, ctx.now);
    ctx.background(screenProfile(env, update, ctx.now));
    return;
  }
  if (after === "left" || after === "kicked") {
    await labelMember(env.DB, chatId, userId, after === "kicked" ? "banned" : "left", ctx.now);
    await footprint(env, chatId, userId, "leave", { status: after, by: update.from.id !== user.id ? who(update.from) : "self" }, ctx.now);
  }
}

// Bio, profile channel and photo: where "say nothing, the profile is the ad" accounts advertise.
async function screenProfile(env: Env, update: ChatMemberUpdated, now: number) {
  const user = update.new_chat_member.user;
  const chatId = String(update.chat.id);
  const profile = await profileOf(env, user, now, true);
  const dossier: Dossier = {
    ...(await dossierOf(env, chatId, user, { profile, joinedAt: now }, now)),
    edited: false,
    kind: "none",
    text: "(they have just joined and not posted yet)",
  };
  const targets = targetsOf(dossier);
  const skipped = await modelsWorthAsking(env, String(user.id), targets, null, 0, now);
  const [decision, textModel] = skipped
    ? [null, null]
    : await Promise.all([decideText(env, forModels(dossier)), judgeText(env, forModels(dossier))]);
  if (!skipped) await recordSpend(env.DB, NEURONS.decision + NEURONS.verdict, now);
  await footprint(env, chatId, String(user.id), "verdict", {
    on: "profile",
    lexicon: profileWords([dossier.name, user.username, profile?.bio, profile?.personal_chat].filter(Boolean).join(" ")),
    targets,
    skipped,
    decision,
    text_model: textModel,
    dossier,
  }, Date.now());
}

// The person's profile, from Telegram when Kitan has none, it is a week old, or `fresh` asks;
// each read from Telegram is also a footprint, so bio changes can be traced.
async function profileOf(env: Env, user: TelegramUser, now: number, fresh: boolean): Promise<Profile | null> {
  const userId = String(user.id);
  const stored = await readProfile(env.DB, userId);
  if (stored && !fresh && now - stored.checked_at < PROFILE_MS) return stored;
  const info = await callTelegram<{ bio?: string; personal_chat?: { title?: string; username?: string }; photo?: unknown }>(
    env,
    "getChat",
    { chat_id: user.id },
  ).catch((error) => ({ error: messageOf(error) }) as { error: string });
  if ("error" in info) {
    await footprint(env, "", userId, "profile", { error: info.error }, now);
    return stored;
  }
  const profile: Profile = {
    name: displayName(user),
    username: user.username ?? null,
    bio: info.bio ?? null,
    personal_chat: info.personal_chat ? `${info.personal_chat.title ?? ""} @${info.personal_chat.username ?? ""}` : null,
    has_photo: Boolean(info.photo),
    premium: user.is_premium ?? false,
    lang: user.language_code ?? null,
    checked_at: now,
  };
  await writeProfile(env.DB, userId, profile);
  await footprint(env, "", userId, "profile", { ...profile }, now);
  return profile;
}

// What the models are told about the sender, apart from the message itself.
async function dossierOf(
  env: Env,
  chatId: string,
  user: TelegramUser,
  seen: { profile: Profile | null; joinedAt: number | null; messages?: number; groups?: number },
  now: number,
): Promise<Omit<Dossier, "edited" | "text" | "kind">> {
  const { profile, joinedAt } = seen;
  const [group, join] = await Promise.all([chatTitle(env.DB, chatId), latestJoin(env.DB, chatId, String(user.id))]);
  const admittedBy = !join
    ? undefined
    : join.by_kitan
      ? "Kitan's check (a captcha)"
      : join.invite_link
        ? `invite link "${join.invite_link}"${join.invite_link_creator ? ` made by ${join.invite_link_creator}` : ""}`
        : (join.approved_by ?? "themselves (open group)");
  return {
    group: group ?? undefined,
    name: displayName(user),
    username: user.username,
    bio: profile?.bio ?? undefined,
    personalChat: profile?.personal_chat ?? undefined,
    accountYears: Math.round(accountYears(user.id, now) * 10) / 10,
    admittedBy,
    minutesSinceJoin: joinedAt === null ? null : Math.round((now - joinedAt) / 60_000),
    messages: seen.messages,
    groups: seen.groups,
  };
}

async function rememberChat(env: Env, chat: TelegramChat, now: number) {
  await noteChat(env.DB, String(chat.id), { title: chat.title ?? null, username: chat.username ?? null, type: chat.type ?? null }, now);
}

// ---------- messages ----------

export async function onGroupMessage(env: Env, message: Message, ctx: Context): Promise<void> {
  const chatId = String(message.chat.id);
  ctx.background(rememberChat(env, message.chat, ctx.now));
  const kind = messageKind(message);
  if (kind === "service") return;

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
  const answered = repliesTo(message);
  if (answered && !ctx.edited) ctx.background(creditReply(env.DB, String(answered.id), ctx.now));

  const mayBeLeftAlone = trajectory.messages > ACTIVE_AFTER || standing.joinedAt === null;
  const anomaly = mayBeLeftAlone ? await anomalyScore(env, trajectory, from.id, ctx.now) : null;
  const review = needsReview(
    { joinedAt: standing.joinedAt, messages: trajectory.messages, firstAt: trajectory.firstAt, anomaly },
    await countingSince(env.DB),
    ctx.now,
  );
  await writeStanding(env.DB, chatId, userId, trajectory, !standing.known && !ctx.edited, ctx.now, review.review);
  if (!review.review) return;

  await footprint(env, chatId, userId, ctx.edited ? "edit" : "message", {
    review: review.why,
    anomaly,
    messages: trajectory.messages,
    minutes_since_join: standing.joinedAt === null ? null : Math.round((ctx.now - standing.joinedAt) / 60_000),
    name: displayName(from),
    username: from.username,
    social: social(trajectory),
    replies_to: answered ? String(answered.id) : undefined,
    // Everything the rules read, so the rules can be replayed exactly.
    facts: messageFacts(message),
  }, ctx.now);

  const { enforced, seenBefore } = await enforceRules(env, message, from, ctx, trajectory);
  // A copy of what they just sent gets the same answer; floods would otherwise cost the most.
  if (!seenBefore) ctx.background(shadow(env, message, from, { ...standing, trajectory }, review, ctx, enforced));
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
    media: messageKind(message) !== "text",
    chars: text.length,
    reply: repliesTo(message) !== null,
    sticker: Boolean(message.sticker),
  };
}

// The other person this message answers, if it answers one: not themselves, not a bot, and
// not a forum topic's opening notice, which every message in a topic replies to.
function repliesTo(message: Message): TelegramUser | null {
  const to = message.reply_to_message;
  if (!to?.from || to.forum_topic_created !== undefined) return null;
  if (to.from.is_bot || to.from.id === message.from?.id) return null;
  return to.from;
}

async function anomalyScore(env: Env, trajectory: Trajectory, userId: number, now: number): Promise<number | null> {
  const forest = await loadForest(env.DB, now);
  return forest ? Math.round(score(forest, features(trajectory, userId, now)) * 1000) / 1000 : null;
}

// Deterministic rules for people under review. Returns what was done, for the footprint, and
// whether they sent the same thing here within DUPLICATE_WINDOW_MS.
async function enforceRules(
  env: Env,
  message: Message,
  from: TelegramUser,
  ctx: Context,
  trajectory: Trajectory,
): Promise<{ enforced: { rule: string; action: string } | null; seenBefore: boolean }> {
  const chatId = String(message.chat.id);
  const userId = String(from.id);
  const reason = spamReason(message);
  // An edit changes a message already counted; only new messages count as copies.
  const content = reason || ctx.edited ? null : await contentHash(sameness(message));
  const copies = content
    ? await earlierCopies(env.DB, userId, chatId, content.hash, ctx.now - DUPLICATE_WINDOW_MS, ctx.now)
    : { here: 0, elsewhere: 0 };
  const duplicateElsewhere = copies.elsewhere > 0 && (content?.length ?? 0) >= MIN_DUPLICATE_LENGTH;
  const repeatedHere = copies.here + 1 >= REPEAT_AT;
  const seenBefore = copies.here > 0;
  if (!reason && !duplicateElsewhere && !repeatedHere) return { enforced: null, seenBefore };

  const priorOffenses = await countOffenses(env.DB, userId, ctx.now - OFFENSE_WINDOW_MS);
  const campaign = repeatedHere ? await campaignSigns(env, message, from, trajectory) : {};
  const verdict = judge({ reason, duplicateElsewhere, repeatedHere, priorOffenses, ...campaign, now: ctx.now });
  if (verdict.action === "allow") return { enforced: null, seenBefore };

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
    await burn(env, chatId, userId, ctx.now);
  }
  const words = verdict.reason === "keyword" ? bannedWords(messageText(message)) : undefined;
  const done = { rule: verdict.reason, action: verdict.action, words, ...campaign };
  await footprint(env, chatId, userId, "action", done, ctx.now);
  log(verdict.action === "mute" ? "spam_muted" : "spam_blocked", { chat_id: chatId, user_id: userId, reason: verdict.reason });
  return { enforced: done, seenBefore };
}

// Bans the account in this group and wherever else it is still new, removing its messages.
async function burn(env: Env, chatId: string, userId: string, now: number) {
  const chats = new Set([chatId, ...(await chatsJoinedSince(env.DB, userId, now - 7 * 24 * 60 * 60 * 1000))]);
  for (const chat of chats) await act(env, "banChatMember", { chat_id: chat, user_id: userId, revoke_messages: true });
}

// Whether a flooding sender points people somewhere, and whether anyone has talked with them.
async function campaignSigns(env: Env, message: Message, from: TelegramUser, trajectory: Trajectory) {
  const profile = await readProfile(env.DB, String(from.id));
  const d: Dossier = { name: displayName(from), bio: profile?.bio ?? undefined, personalChat: profile?.personal_chat ?? undefined, edited: false, text: "" };
  const s = social(trajectory);
  return {
    pointsElsewhere: targetsOf(d, message).some(strong),
    sociable: s.replies + s.repliedBy + s.stickers > 0,
  };
}

// Every detector's opinion on this message, recorded for the benchmark; none of it acts.
async function shadow(
  env: Env,
  message: Message,
  from: TelegramUser,
  { joinedAt, groups, trajectory }: { joinedAt: number | null; groups: number; trajectory: Trajectory },
  review: Review,
  ctx: Context,
  enforced: { rule: string; action: string } | null,
) {
  const chatId = String(message.chat.id);
  const userId = String(from.id);
  const text = messageText(message);
  const profile = await profileOf(env, from, ctx.now, false);
  const dossier: Dossier = {
    ...(await dossierOf(env, chatId, from, { profile, joinedAt, messages: trajectory.messages, groups }, ctx.now)),
    kind: messageKind(message),
    edited: ctx.edited,
    text: text || (message.contact ? `[contact card: ${[message.contact.first_name, message.contact.last_name].filter(Boolean).join(" ")}]` : ""),
  };
  const picture = pictureOf(message);
  const targets = targetsOf(dossier, message);
  const skipped = await modelsWorthAsking(env, userId, targets, trajectory, picture ? NEURONS.image : 0, ctx.now);
  const [decision, imageModel, textModel] = skipped
    ? [null, null, null]
    : await Promise.all([
        decideText(env, forModels(dossier)),
        picture ? judgeImage(env, picture.file_id, forModels(dossier)) : null,
        judgeText(env, forModels(dossier)),
      ]);
  if (!skipped) await recordSpend(env.DB, NEURONS.decision + NEURONS.verdict + (picture ? NEURONS.image : 0), ctx.now);
  await footprint(env, chatId, userId, "verdict", {
    on: ctx.edited ? "edit" : "message",
    review: review.why,
    rules: spamReason(message),
    enforced,
    lexicon: { text: chatWords(text), name: profileWords(dossier.name) },
    skipped,
    decision,
    text_model: textModel,
    image_model: imageModel ? { ...imageModel, px: picture?.width } : null,
    targets,
    social: social(trajectory),
    // Everything Kitan knew; the models saw forModels(dossier). Kept whole so a replay can
    // try other views.
    dossier,
  }, Date.now());
}

// The paid models come last, as in the Python bot, where a keyword automaton screened
// profiles and only a member's first 8 messages were checked. They are asked only when
// their answer could matter, and within the free plan's 10,000 neurons a day: on
// 2026-11-13 these gates would have cut 612 calls in ten hours to 130. Returns why not.
const JUDGED_PER_ACCOUNT = 4; // the profile and three distinct messages
const DAILY_NEURONS = 7000; // leaves room for bench runs under the 10,000 allowance

async function modelsWorthAsking(
  env: Env,
  userId: string,
  targets: Target[],
  trajectory: Trajectory | null,
  extra: number,
  now: number,
): Promise<"no_target" | "sociable" | "judged_enough" | "budget" | "paused" | null> {
  // Without somewhere to send people there is no ad to act on, whatever a model says.
  if (!targets.some(strong)) return "no_target";
  if (trajectory) {
    const s = social(trajectory);
    if (s.replies + s.repliedBy + s.stickers > 0) return "sociable";
  }
  if (modelsPaused(now)) return "paused";
  if ((await judgedSince(env.DB, userId, now - NEWCOMER_MS)) >= JUDGED_PER_ACCOUNT) return "judged_enough";
  const cost = NEURONS.decision + NEURONS.verdict + extra;
  if ((await spentToday(env.DB, now)) + cost > DAILY_NEURONS) return "budget";
  return null;
}

// Where this sender points people, from the message and everything on their profile.
function targetsOf(d: Dossier, message?: Message) {
  return diversionTargets({
    message: message ? messageText(message) : undefined,
    name: d.name,
    bio: d.bio,
    channel: d.personalChat,
    contact: message?.contact ? [message.contact.first_name, message.contact.last_name].filter(Boolean).join(" ") || "card" : undefined,
    buttons: message?.reply_markup?.inline_keyboard?.flat().flatMap((b) => (b.url ? [b.url] : [])),
  }).map((t) => ({ ...t, value: t.value.slice(0, 80) }));
}

// A photo at the size the image model reads, or the preview Telegram makes of a video,
// GIF or file: spam often comes as a short video with the ad written on it.
function pictureOf(message: Message): PhotoSize | undefined {
  if (message.photo?.length) return largestUnder(message.photo, IMAGE_PX);
  return (message.video ?? message.animation ?? message.document ?? message.video_note)?.thumbnail;
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
function messageFacts(message: Message): Partial<Message> & { kind: string; media?: Record<string, unknown> } {
  const media = message.video ?? message.animation ?? message.document ?? message.sticker ?? message.video_note ?? message.voice ?? message.audio;
  return {
    kind: messageKind(message),
    media: media && {
      duration: media.duration,
      mime_type: media.mime_type,
      thumbnail: media.thumbnail?.file_id,
      file_name: message.document?.file_name,
      emoji: message.sticker?.emoji,
      set_name: message.sticker?.set_name,
    },
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
    // Whose card it is, not their phone number.
    contact: message.contact && {
      phone_number: "",
      first_name: message.contact.first_name,
      last_name: message.contact.last_name,
      user_id: message.contact.user_id,
    },
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
