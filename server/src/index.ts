import { loadConfig } from "./config";
import { verifyInitData } from "./crypto";
import { Store } from "./db";
import { decideMessage } from "./decision";
import { renderPage } from "./page";
import { messageFeatures } from "./signals";
import {
  ALLOW_ALL,
  DENY_ALL,
  TelegramClient,
  TelegramError,
} from "./telegram";
import { verifyTurnstile } from "./turnstile";
import type {
  InitData,
  MemberRow,
  TelegramCallbackQuery,
  TelegramChatJoinRequest,
  TelegramChatMemberUpdated,
  TelegramMessage,
  TelegramUpdate,
  Verdict,
} from "./types";

const config = loadConfig();
const store = new Store(config.databasePath);
const telegram = new TelegramClient(config.botToken, config.apiBase);

function log(event: string, data: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...data }));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isJoinRequestGone(error: unknown): boolean {
  return (
    error instanceof TelegramError &&
    /HIDE_REQUESTER_MISSING|USER_ALREADY_PARTICIPANT|JOIN_REQUEST/.test(
      error.message,
    )
  );
}

class VerifyError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "VerifyError";
  }
}

interface VerifyBody {
  initData?: string;
  turnstileToken?: string;
  token?: string;
}

const me = await telegram.getMe().catch((error) => {
  log("get_me_failed", { error: messageOf(error) });
  throw error;
});
const botUsername = me.username ?? "";
await telegram.deleteWebhook().catch((error) => {
  log("delete_webhook_failed", { error: messageOf(error) });
});

const adminCache = new Map<string, { value: boolean; expiresAt: number }>();
const verifyWindows = new Map<string, { count: number; resetAt: number }>();

function allowVerify(ip: string): boolean {
  const now = Date.now();
  const entry = verifyWindows.get(ip);
  if (!entry || entry.resetAt <= now) {
    if (verifyWindows.size > 10_000) {
      for (const [key, value] of verifyWindows) {
        if (value.resetAt <= now) {
          verifyWindows.delete(key);
        }
      }
    }
    verifyWindows.set(ip, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (entry.count >= 60) {
    return false;
  }
  entry.count += 1;
  return true;
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: config.port,
  fetch: handleRequest,
});

let running = true;
let offset = 0;
let backoff = 1_000;

log("started", {
  port: server.port,
  database: config.databasePath,
  bot: botUsername,
});

void poll();

async function poll(): Promise<void> {
  await expirePending();
  while (running) {
    try {
      const updates = await telegram.getUpdates(offset, 25);
      for (const update of updates) {
        const claimed = store.claimUpdate(update.update_id);
        if (claimed) {
          try {
            await handleUpdate(update);
          } catch (error) {
            store.releaseUpdate(update.update_id);
            log("update_failed", {
              update_id: update.update_id,
              error: messageOf(error),
            });
            break;
          }
        }
        offset = update.update_id + 1;
      }
      await expirePending();
      backoff = 1_000;
    } catch (error) {
      const wait =
        error instanceof TelegramError && error.retryAfter
          ? (error.retryAfter + 1) * 1_000
          : backoff;
      log("poll_failed", { error: messageOf(error), wait });
      await Bun.sleep(wait);
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
  store.close();
  process.exit(0);
}

async function handleUpdate(update: TelegramUpdate): Promise<void> {
  if (update.chat_join_request) {
    await onJoinRequest(update.chat_join_request);
    return;
  }
  if (update.chat_member) {
    onChatMember(update.chat_member);
    return;
  }
  if (update.message) {
    await onMessage(update.message);
    return;
  }
  if (update.edited_message) {
    await onMessage(update.edited_message);
    return;
  }
  if (update.callback_query) {
    await onCallback(update.callback_query);
  }
}

async function onJoinRequest(
  request: TelegramChatJoinRequest,
): Promise<void> {
  const chatId = String(request.chat.id);
  const userId = String(request.from.id);
  const now = Date.now();
  store.touchUser(userId, now);

  if (store.isGloballyBlocked(userId, now)) {
    await telegram
      .declineChatJoinRequest(chatId, userId)
      .catch((error) => {
        log("join_decline_failed", { chat_id: chatId, user_id: userId, error: messageOf(error) });
      });
    log("join_blocked", { chat_id: chatId, user_id: userId });
    return;
  }

  const token = crypto.randomUUID().replace(/-/g, "");
  const title = request.chat.title ?? "the group";
  const verifyUrl = `${config.publicAppUrl}/?token=${encodeURIComponent(token)}`;
  store.upsertPending({
    token,
    chatId,
    userId,
    now,
    expiresAt: now + 5 * 60 * 1000,
  });

  try {
    const sent = await telegram.sendMessage(
      userId,
      `To join "${title}", complete the human check.`,
      {
        inline_keyboard: [
          [
            {
              text: "Verify",
              web_app: { url: verifyUrl },
            },
          ],
        ],
      },
    );
    store.setPendingMessage(token, String(sent.message_id));
    log("join_challenge", { chat_id: chatId, user_id: userId });
  } catch (error) {
    store.deletePending(token);
    await telegram
      .declineChatJoinRequest(chatId, userId)
      .catch((declineError) => {
        log("join_decline_failed", {
          chat_id: chatId,
          user_id: userId,
          error: messageOf(declineError),
        });
      });
    log("join_challenge_failed", {
      chat_id: chatId,
      user_id: userId,
      error: messageOf(error),
    });
  }
}

function onChatMember(update: TelegramChatMemberUpdated): void {
  const user = update.new_chat_member.user;
  if (user.is_bot) {
    return;
  }
  const chatId = String(update.chat.id);
  const userId = String(user.id);
  const oldStatus = update.old_chat_member.status;
  const newStatus = update.new_chat_member.status;
  const now = Date.now();

  if (
    (newStatus === "member" || newStatus === "restricted") &&
    (oldStatus === "left" || oldStatus === "kicked")
  ) {
    store.ensureMember(chatId, userId, "probation", now);
    return;
  }

  if (newStatus === "left" || newStatus === "kicked") {
    if (store.getMember(chatId, userId)) {
      store.setMemberState(
        chatId,
        userId,
        newStatus === "kicked" ? "banned" : "left",
        now,
      );
    }
  }
}

async function onMessage(message: TelegramMessage): Promise<void> {
  const from = message.from;
  if (!from || from.is_bot) {
    return;
  }
  const chatId = String(message.chat.id);
  const userId = String(from.id);
  const text = message.text ?? "";

  if (message.chat.type === "private") {
    if (text.startsWith("/start")) {
      await handleStart(chatId);
    }
    return;
  }
  if (message.chat.type !== "group" && message.chat.type !== "supergroup") {
    return;
  }

  if (text.startsWith("/")) {
    await handleCommand(chatId, userId, text);
    return;
  }

  const member = store.getMember(chatId, userId);
  if (!member || member.state === "left" || member.state === "banned") {
    return;
  }

  const now = Date.now();
  store.bumpObserved(chatId, userId, now);
  refreshMemberState(chatId, userId, member, now);

  if (!store.getSettings(chatId).antiSpam) {
    return;
  }

  const features = messageFeatures(message);
  store.recordMessage(chatId, userId, features.hash, features.length, now);
  const stats = store.recentStats(chatId, userId, now);
  const duplicateCount = store.duplicateCount(
    chatId,
    userId,
    features.hash,
    now,
    10 * 60 * 1000,
  );
  const verdict = decideMessage({
    text: features.text,
    state: member.state,
    recentCount: stats.recent,
    shortCount: stats.short,
    duplicateCount,
    mediaOnly: features.mediaOnly,
    external: features.external,
    mentions: features.mentions,
  });

  if (verdict.action === "allow") {
    return;
  }
  await applyVerdict(message, userId, member, verdict, features.text);
}

function refreshMemberState(
  chatId: string,
  userId: string,
  member: MemberRow,
  now: number,
): void {
  const age = now - member.first_seen;
  if (
    member.state === "probation" &&
    member.observed + 1 >= 20 &&
    age >= 24 * 60 * 60 * 1000
  ) {
    store.setMemberState(chatId, userId, "member", now);
    return;
  }
  if (
    member.state === "member" &&
    member.observed + 1 >= 50 &&
    age >= 7 * 24 * 60 * 60 * 1000
  ) {
    store.setMemberState(chatId, userId, "trusted", now);
  }
}

async function applyVerdict(
  message: TelegramMessage,
  userId: string,
  member: MemberRow,
  verdict: Verdict,
  text: string,
): Promise<void> {
  const chatId = String(message.chat.id);
  const now = Date.now();

  if (verdict.action === "remove" || verdict.action === "restrict") {
    await telegram
      .deleteMessage(chatId, message.message_id)
      .catch((error) => {
        log("delete_failed", {
          chat_id: chatId,
          message_id: message.message_id,
          error: messageOf(error),
        });
      });
  }

  if (verdict.action === "remove" || verdict.action === "restrict") {
    const seconds = member.offenses >= 1 ? 3_600 : 600;
    await telegram
      .restrictChatMember(
        chatId,
        userId,
        DENY_ALL,
        Math.floor(now / 1000) + seconds,
      )
      .catch((error) => {
        log("restrict_failed", {
          chat_id: chatId,
          user_id: userId,
          error: messageOf(error),
        });
      });
    store.addOffense(chatId, userId, now);
    store.addUserOffense(userId, now);
  }

  await notifyAdmin(chatId, userId, verdict, text);
}

async function notifyAdmin(
  chatId: string,
  userId: string,
  verdict: Verdict,
  text: string,
): Promise<void> {
  if (!config.adminUserId) {
    return;
  }
  const reasons =
    verdict.reasons.map((reason) => reason.name).join(", ") || "review";
  const snippet = text.trim().slice(0, 280);
  const body = [
    "Kitan",
    `Group: ${chatId}`,
    `User: ${userId}`,
    `Action: ${verdict.action}`,
    `Reason: ${reasons}`,
    snippet ? `Message: ${snippet}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  await telegram
    .sendMessage(config.adminUserId, body, {
      inline_keyboard: [
        [
          {
            text: "Release",
            callback_data: `gate:release:${chatId}:${userId}`,
          },
          { text: "Ban", callback_data: `gate:ban:${chatId}:${userId}` },
        ],
      ],
    })
    .catch((error) => {
      log("admin_notify_failed", { error: messageOf(error) });
    });
}

async function handleCommand(
  chatId: string,
  userId: string,
  text: string,
): Promise<void> {
  const match =
    /^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+(.*))?$/.exec(text);
  if (!match || match[1] !== "anti_spam") {
    return;
  }
  if (!(await isChatAdmin(chatId, userId))) {
    await telegram
      .sendMessage(chatId, "Only administrators can change this setting.")
      .catch(() => {});
    return;
  }
  const enabled = store.toggleAntiSpam(chatId);
  await telegram
    .sendMessage(
      chatId,
      `Anti-spam is now ${enabled ? "enabled" : "disabled"}.`,
    )
    .catch(() => {});
}

async function isChatAdmin(
  chatId: string,
  userId: string,
): Promise<boolean> {
  const key = `${chatId}:${userId}`;
  const cached = adminCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }
  try {
    const member = await telegram.getChatMember(chatId, userId);
    const value =
      member.status === "administrator" || member.status === "creator";
    if (adminCache.size > 1_000) {
      adminCache.clear();
    }
    adminCache.set(key, { value, expiresAt: Date.now() + 5 * 60 * 1000 });
    return value;
  } catch (error) {
    log("admin_check_failed", {
      chat_id: chatId,
      user_id: userId,
      error: messageOf(error),
    });
    return false;
  }
}

async function handleStart(chatId: string): Promise<void> {
  const invite = botUsername
    ? `https://t.me/${botUsername}?startgroup&admin=can_invite_users+restrict_members+delete_messages`
    : "";
  const text = [
    "Kitan verifies join requests and watches new members for spam.",
    invite ? `Add me to a group: ${invite}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  await telegram.sendMessage(chatId, text).catch((error) => {
    log("start_failed", { chat_id: chatId, error: messageOf(error) });
  });
}

async function onCallback(query: TelegramCallbackQuery): Promise<void> {
  const parts = (query.data ?? "").split(":");
  if (parts.length !== 4) {
    await telegram.answerCallbackQuery(query.id).catch(() => {});
    return;
  }

  if (
    !config.adminUserId ||
    String(query.from.id) !== config.adminUserId
  ) {
    await telegram.answerCallbackQuery(query.id, "Not allowed").catch(() => {});
    return;
  }

  const [prefix, action, chatId, userId] = parts;
  if (prefix !== "gate") {
    await telegram.answerCallbackQuery(query.id).catch(() => {});
    return;
  }

  if (action === "release") {
    await telegram.unbanChatMember(chatId, userId).catch((error) => {
      log("unban_failed", { chat_id: chatId, user_id: userId, error: messageOf(error) });
    });
    await telegram
      .restrictChatMember(chatId, userId, ALLOW_ALL)
      .catch((error) => {
        log("release_failed", { chat_id: chatId, user_id: userId, error: messageOf(error) });
      });
    store.setMemberState(chatId, userId, "member", Date.now());
    store.resetOffenses(chatId, userId);
    await telegram.answerCallbackQuery(query.id, "Released").catch(() => {});
    return;
  }

  if (action === "ban") {
    await telegram.banChatMember(chatId, userId).catch((error) => {
      log("ban_failed", { chat_id: chatId, user_id: userId, error: messageOf(error) });
    });
    store.setMemberState(chatId, userId, "banned", Date.now());
    await telegram.answerCallbackQuery(query.id, "Banned").catch(() => {});
    return;
  }

  await telegram.answerCallbackQuery(query.id).catch(() => {});
}

async function expirePending(): Promise<void> {
  const expired = store.takeExpiredPending(Date.now());
  for (const pending of expired) {
    await telegram
      .declineChatJoinRequest(pending.chat_id, pending.user_id)
      .catch((error) => {
        log("expire_decline_failed", {
          chat_id: pending.chat_id,
          user_id: pending.user_id,
          error: messageOf(error),
        });
      });
    if (pending.message_id) {
      await telegram
        .deleteMessage(pending.user_id, Number(pending.message_id))
        .catch(() => {});
    }
    await telegram
      .sendMessage(
        pending.user_id,
        "Your join request expired. Request to join again.",
      )
      .catch(() => {});
    log("join_expired", {
      chat_id: pending.chat_id,
      user_id: pending.user_id,
    });
  }
}

async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(renderPage(config.turnstileSiteKey), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "content-security-policy":
            "default-src 'none'; script-src 'unsafe-inline' https://telegram.org https://challenges.cloudflare.com; style-src 'unsafe-inline'; img-src data:; connect-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; base-uri 'none'; form-action 'none'",
        },
      });
    }
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true });
    }
    if (request.method === "POST" && url.pathname === "/api/verify") {
      return await handleVerify(request);
    }
    return json({ error: "not found" }, 404);
  } catch (error) {
    if (error instanceof VerifyError) {
      return json({ error: error.message }, error.status);
    }
    log("request_failed", { path: url.pathname, error: messageOf(error) });
    return json({ error: "internal error" }, 500);
  }
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

async function handleVerify(request: Request): Promise<Response> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > 64 * 1024) {
    throw new VerifyError(413, "Request too large.");
  }
  const remoteIp =
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown";
  if (!allowVerify(remoteIp)) {
    throw new VerifyError(429, "Too many attempts. Try again later.");
  }

  let body: VerifyBody;
  try {
    body = (await request.json()) as VerifyBody;
  } catch {
    throw new VerifyError(400, "Invalid request.");
  }
  if (!body.initData || !body.token) {
    throw new VerifyError(400, "Open this page from the verification message.");
  }

  let data: InitData;
  try {
    data = await verifyInitData(body.initData, config.botToken, 15 * 60);
  } catch (error) {
    log("verify_initdata_failed", { error: messageOf(error) });
    throw new VerifyError(400, "This verification link is invalid or expired.");
  }

  const pending = store.getPending(body.token);
  if (!pending) {
    throw new VerifyError(410, "This request expired. Request to join again.");
  }
  if (pending.user_id !== String(data.user.id)) {
    throw new VerifyError(400, "This verification request does not match.");
  }
  if (pending.expires_at < Date.now()) {
    store.deletePending(body.token);
    await telegram
      .declineChatJoinRequest(pending.chat_id, pending.user_id)
      .catch(() => {});
    if (pending.message_id) {
      await telegram
        .deleteMessage(pending.user_id, Number(pending.message_id))
        .catch(() => {});
    }
    throw new VerifyError(410, "This request expired. Request to join again.");
  }

  if (config.turnstileSecretKey) {
    try {
      await verifyTurnstile(
        config.turnstileSecretKey,
        body.turnstileToken,
        remoteIp,
      );
    } catch (error) {
      log("turnstile_failed", {
        token: body.token,
        error: messageOf(error),
      });
      throw new VerifyError(400, "The check failed. Try again.");
    }
  } else if (!config.allowInsecure) {
    throw new VerifyError(503, "Verification is not configured.");
  }

  const consumed = store.consumePending(body.token);
  if (!consumed) {
    throw new VerifyError(409, "Verification is already in progress.");
  }

  try {
    await telegram.approveChatJoinRequest(consumed.chat_id, consumed.user_id);
  } catch (error) {
    if (
      error instanceof TelegramError &&
      error.message.includes("USER_ALREADY_PARTICIPANT")
    ) {
      // The user is already in the group; keep going.
    } else if (isJoinRequestGone(error)) {
      if (consumed.message_id) {
        await telegram
          .deleteMessage(consumed.user_id, Number(consumed.message_id))
          .catch(() => {});
      }
      throw new VerifyError(410, "This request is no longer available.");
    } else {
      log("approve_failed", {
        chat_id: consumed.chat_id,
        user_id: consumed.user_id,
        error: messageOf(error),
      });
      throw new VerifyError(502, "Telegram is unavailable. Try again.");
    }
  }

  if (consumed.message_id) {
    await telegram
      .deleteMessage(consumed.user_id, Number(consumed.message_id))
      .catch(() => {});
  }
  store.ensureMember(consumed.chat_id, consumed.user_id, "probation", Date.now());
  log("join_approved", {
    chat_id: consumed.chat_id,
    user_id: consumed.user_id,
  });
  return json({ ok: true });
}

function shutdown(signal: string): void {
  if (!running) {
    return;
  }
  running = false;
  server.stop();
  log("shutdown", { signal });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
