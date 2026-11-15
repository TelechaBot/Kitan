// Watches groups by behaviour. Every person's activity updates a sketch of how they
// behave across Kitan groups (trajectory.ts). A member is reviewed only while they have
// fewer than seven clean messages in the last seven days in that group; after that the
// group's own life is proof enough (needsReview). Review means the deterministic rules
// act at once while keyword and model judgements run in the background and are only
// recorded (shadow mode). Reviewed people leave footprints in `events`; people left
// alone are not recorded.
import { type Dossier, NEURONS, decideText, forModels, judgeImage, judgeText, modelsPaused } from "./classify";
import {
  type Profile,
  chatTitle,
  chatsJoinedSince,
  countOffenses,
  creditReply,
  earlierCopies,
  insertOffense,
  labelMember,
  latestJoin,
  noteChat,
  judgedSince,
  readProfile,
  recordSpend,
  spentToday,
  writeProfile,
  prune,
  readStanding,
  readTrajectory,
  recordEvent,
  recordJoin,
  revokeRecentAt,
  writeStanding,
} from "./db";
import { pickLang, t } from "./i18n";
import { bannedWords, chatWords, profileWords } from "./lexicon";
import {
  type Target,
  DUPLICATE_WINDOW_MS,
  MIN_DUPLICATE_LENGTH,
  OFFENSE_WINDOW_MS,
  PROBATION_MESSAGES,
  PROBATION_WINDOW_MS,
  REPEAT_AT,
  type Review,
  type SpamReason,
  contentHash,
  hasLinkButton,
  judge,
  messageTargetCounts,
  ruleOf,
  messageKind,
  messageText,
  needsReview,
  sameness,
  diversionTargets,
  spamReason,
  strong,
} from "./probation";
import { offerAppeal } from "./appeal";
import { callTelegram, log, messageOf, sendPermissions } from "./telegram";
import { type Trajectory, accountYears, social, step } from "./trajectory";
import type { ChatMemberUpdated, Env, Message, PhotoSize, TelegramChat, TelegramUser } from "./types";

// A profile read from Telegram is reused for a week; spam accounts do change their bio.
const PROFILE_MS = 7 * 24 * 60 * 60 * 1000;

const FOOTPRINT_MS = 14 * 24 * 60 * 60 * 1000;
const EXCERPT = 500;
// Telegram's mid photo size: same verdicts as 1280 px in bench/, at a quarter of the cost.
const IMAGE_PX = 320;


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
  // A join request just read the profile, so reuse it there; refresh only a stale one.
  const profile = await profileOf(env, user, now, false);
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
export async function profileOf(env: Env, user: TelegramUser, now: number, fresh: boolean): Promise<Profile | null> {
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

  // Probation is per person and per group: only their own clean messages, only the last week.
  const recent = standing.recentAts.filter((t) => t > ctx.now - PROBATION_WINDOW_MS);
  const review = needsReview(recent.length);
  const firstInChat = !standing.known && !ctx.edited;

  // Admins are never moderated, whatever they post and however new they are. Their clean
  // messages still count towards probation, so they are not reviewed forever.
  if (review.review && (await isAdmin(env, chatId, from.id))) {
    await writeStanding(
      env.DB,
      chatId,
      userId,
      trajectory,
      firstInChat,
      ctx.now,
      false,
      standing.updatedAt,
      ctx.edited ? null : [...recent, ctx.now].slice(-PROBATION_MESSAGES),
    );
    return;
  }

  // Past probation: no admin lookup, no footprint, no rules, no shadow. Slide the window
  // only every six hours, so a busy regular costs at most four writes a day.
  if (!review.review) {
    const slide = !ctx.edited && recent.length > 0 && ctx.now - recent[0] >= 6 * 60 * 60 * 1000;
    await writeStanding(
      env.DB,
      chatId,
      userId,
      trajectory,
      firstInChat,
      ctx.now,
      false,
      standing.updatedAt,
      slide ? [...recent.slice(-(PROBATION_MESSAGES - 1)), ctx.now] : null,
    );
    return;
  }

  await footprint(env, chatId, userId, ctx.edited ? "edit" : "message", {
    review: review.why,
    recent: recent.length,
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
  // A clean message counts towards graduation; deleted spam never does.
  const clean = !ctx.edited && enforced === null;
  await writeStanding(
    env.DB,
    chatId,
    userId,
    trajectory,
    firstInChat,
    ctx.now,
    true,
    standing.updatedAt,
    clean ? [...recent, ctx.now].slice(-PROBATION_MESSAGES) : null,
  );
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
  const rule = ruleOf({ reason, duplicateElsewhere, repeatedHere })!;
  const done = await applyPenalty(env, message, from, ctx, trajectory, rule, priorOffenses);
  return { enforced: done, seenBefore };
}

async function applyPenalty(
  env: Env,
  message: Message,
  from: TelegramUser,
  ctx: Context,
  trajectory: Trajectory,
  rule: SpamReason,
  priorOffenses: number,
): Promise<{ rule: string; action: string } | null> {
  const chatId = String(message.chat.id);
  const userId = String(from.id);
  const signs = await senderSigns(env, message, from, trajectory, messageTargetCounts(rule));
  const verdict = judge({
    reason: rule === "cross_group_duplicate" || rule === "repeated" ? null : rule,
    duplicateElsewhere: rule === "cross_group_duplicate",
    repeatedHere: rule === "repeated",
    priorOffenses,
    ...signs,
    now: ctx.now,
  });
  if (verdict.action === "allow") return null;

  await insertOffense(env.DB, userId, chatId, verdict.reason, verdict.score, ctx.now);
  let noticeSent: string | undefined;
  await act(env, "deleteMessage", { chat_id: chatId, message_id: message.message_id });
  if (verdict.action === "mute") {
    const until = Math.floor(verdict.until / 1000);
    await act(env, "restrictChatMember", {
      chat_id: chatId,
      user_id: userId,
      permissions: sendPermissions(false),
      use_independent_chat_permissions: true,
      until_date: until,
    });
    // Tell only them why, until when, and how to lift it now if this was a mistake.
    // Telegram shows the time in their own time zone; the text inside is the fallback.
    const fallback = `${new Date(verdict.until).toISOString().slice(0, 16).replace("T", " ")} UTC`;
    const button = await offerAppeal(
      env,
      { chatId, userId, rule: verdict.reason, score: verdict.score, until: verdict.until, lang: from.language_code },
      ctx.now,
    ).catch((error) => {
      log("appeal_offer_failed", { error: messageOf(error) });
      return null;
    });
    const notice = {
      chat_id: chatId,
      text: t(pickLang(from.language_code), "muted", { time: `<tg-time unix="${until}" format="dt">${fallback}</tg-time>` }),
      parse_mode: "HTML",
      ephemeral_message_parameters: { receiver_user_id: from.id },
    };
    // The Bot API does not say whether ephemeral messages take buttons; if not, the notice still goes.
    noticeSent = await callTelegram(env, "sendMessage", button ? { ...notice, reply_markup: { inline_keyboard: [[button]] } } : notice)
      .then(() => (button ? "with_button" : "plain"))
      .catch(async (error) => {
        log("muted_notice_with_button_failed", { chat_id: chatId, error: messageOf(error) });
        await act(env, "sendMessage", notice);
        return `plain_after: ${messageOf(error).slice(0, 120)}`;
      });
  } else {
    await burn(env, chatId, userId, ctx.now);
  }
  const words = verdict.reason === "keyword" ? bannedWords(messageText(message)) : undefined;
  const done = { rule: verdict.reason, action: verdict.action, score: verdict.score, prior: priorOffenses, words, notice: noticeSent, ...signs };
  await footprint(env, chatId, userId, "action", done, ctx.now);
  log(verdict.action === "mute" ? "spam_muted" : "spam_blocked", { chat_id: chatId, user_id: userId, reason: verdict.reason });
  return done;
}

// Bans the account in this group and wherever else it is still new, removing its messages.
async function burn(env: Env, chatId: string, userId: string, now: number) {
  const chats = new Set([chatId, ...(await chatsJoinedSince(env.DB, userId, now - 7 * 24 * 60 * 60 * 1000))]);
  for (const chat of chats) await act(env, "banChatMember", { chat_id: chat, user_id: userId, revoke_messages: true });
}

// Beyond the offending message's text: does the sender point people somewhere (name, bio,
// a contact card), and has anyone talked with them? These move the penalty up or down.
async function senderSigns(env: Env, message: Message, from: TelegramUser, trajectory: Trajectory, withText: boolean) {
  const profile = await readProfile(env.DB, String(from.id));
  const card = message.contact ? [message.contact.first_name, message.contact.last_name].filter(Boolean).join(" ") || "card" : undefined;
  const s = social(trajectory);
  const where = { message: withText ? messageText(message) : undefined, name: displayName(from), bio: profile?.bio ?? undefined, contact: card };
  return {
    pointsElsewhere: diversionTargets(where).some(strong),
    sociable: s.replies + s.repliedBy + s.stickers > 0,
  };
}

// Runs the text and image models in the background; acts only when confident and guarded
// against ordinary conversation, otherwise records what the models saw.
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
  const hasTarget = targets.some(strong);
  const textCost = hasTarget ? NEURONS.decision + NEURONS.verdict : 0;
  const skipped = await modelsWorthAsking(env, userId, targets, trajectory, (picture ? NEURONS.image : 0) - (hasTarget ? 0 : NEURONS.decision + NEURONS.verdict), ctx.now, Boolean(picture));
  const [decision, imageModel, textModel] = skipped
    ? [null, null, null]
    : await Promise.all([
        hasTarget ? decideText(env, forModels(dossier)) : null,
        picture ? judgeImage(env, picture.file_id, forModels(dossier)) : null,
        hasTarget ? judgeText(env, forModels(dossier)) : null,
      ]);
  if (!skipped) await recordSpend(env.DB, textCost + (picture ? NEURONS.image : 0), ctx.now);
  let outcome = enforced;
  if (!outcome && !skipped) {
    const textAd = hasTarget && decision !== null && decision.p >= 0.9 && textModel !== null && textModel.ad && textModel.confidence >= 0.85;
    const imageAd = imageModel !== null && imageModel.ad && imageModel.confidence >= 0.9 && ((imageModel.transcript ?? "").trim().length > 0 || hasTarget);
    if (textAd || imageAd) {
      const priorOffenses = await countOffenses(env.DB, userId, ctx.now - OFFENSE_WINDOW_MS);
      outcome = await applyPenalty(env, message, from, ctx, trajectory, "llm", priorOffenses);
      if (outcome && !ctx.edited) await revokeRecentAt(env.DB, chatId, userId, ctx.now);
    }
  }
  await footprint(env, chatId, userId, "verdict", {
    on: ctx.edited ? "edit" : "message",
    review: review.why,
    rules: spamReason(message),
    enforced: outcome,
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
export const DAILY_NEURONS = 7000; // leaves room for bench runs under the 10,000 allowance

async function modelsWorthAsking(
  env: Env,
  userId: string,
  targets: Target[],
  trajectory: Trajectory | null,
  extra: number,
  now: number,
  hasPicture = false,
): Promise<"no_target" | "sociable" | "judged_enough" | "budget" | "paused" | null> {
  // Without somewhere to send people there is no ad to act on, unless an image itself may carry one.
  if (!hasPicture && !targets.some(strong)) return "no_target";
  if (trajectory) {
    const s = social(trajectory);
    if (s.replies + s.repliedBy + s.stickers > 0) return "sociable";
  }
  if (modelsPaused(now)) return "paused";
  if ((await judgedSince(env.DB, userId, now - PROBATION_WINDOW_MS)) >= JUDGED_PER_ACCOUNT) return "judged_enough";
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

const adminCaches = new WeakMap<D1Database, Map<string, { admin: boolean; until: number }>>();

function adminCache(db: D1Database) {
  let cache = adminCaches.get(db);
  if (!cache) adminCaches.set(db, (cache = new Map()));
  return cache;
}

async function isAdmin(env: Env, chatId: string, userId: number): Promise<boolean> {
  const cache = adminCache(env.DB);
  const key = `${chatId}:${userId}`;
  const cached = cache.get(key);
  if (cached && cached.until > Date.now()) return cached.admin;
  let member: { status: string };
  try {
    member = await callTelegram<{ status: string }>(env, "getChatMember", { chat_id: chatId, user_id: userId });
  } catch (error) {
    // A failed lookup says nothing about their rights. Do not cache "not an admin" for ten
    // minutes: ask again next message rather than moderate an admin through an outage.
    log("getChatMember_failed", { chat_id: chatId, user_id: userId, error: messageOf(error) });
    return false;
  }
  const admin = member.status === "creator" || member.status === "administrator";
  cache.set(key, { admin, until: Date.now() + 10 * 60 * 1000 });
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

export async function avatarFileId(env: Env, userId: number): Promise<string | null> {
  const res = await callTelegram<{ total_count?: number; photos?: PhotoSize[][] }>(env, "getUserProfilePhotos", {
    user_id: userId,
    limit: 1,
  }).catch(() => null);
  const first = res?.photos?.[0];
  return first?.length ? largestUnder(first, IMAGE_PX).file_id : null;
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

// Drops copies, offences, footprints and appeals that are past their retention.
export async function hourly(env: Env, now: number): Promise<void> {
  await prune(env.DB, {
    hashes: now - DUPLICATE_WINDOW_MS,
    offenses: now - OFFENSE_WINDOW_MS,
    events: now - FOOTPRINT_MS,
  });
}
