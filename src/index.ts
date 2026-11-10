import { constantTimeEqual, verifyInitData } from "./crypto";
import { pickLang, t } from "./i18n";
import { renderPage } from "./page";
import { isBlocked, lolsBanned, onGroupMessage, pruneModeration } from "./moderation";
import { callTelegram, isGone, log } from "./telegram";
import { verifyTurnstile } from "./turnstile";
import type {
  Attempt,
  ChatJoinRequest,
  ChatMemberUpdated,
  Env,
  InitData,
  Message,
  Update,
} from "./types";

const GUARD_TTL_MS = 10 * 60 * 1000;
const DM_TTL_MS = 5 * 60 * 1000;
const INIT_DATA_MAX_AGE_S = 15 * 60;
const ALLOWED_UPDATES = ["chat_join_request", "chat_member", "message"];

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/") {
        return new Response(renderPage(env.TURNSTILE_SITE_KEY), {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
            "referrer-policy": "no-referrer",
          },
        });
      }
      if (request.method === "GET" && url.pathname === "/health") {
        return json({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/telegram") {
        return await handleWebhook(request, env, url.origin);
      }
      if (request.method === "POST" && url.pathname === "/api/open") {
        return await handleOpen(request, env);
      }
      if (request.method === "POST" && url.pathname === "/api/verify") {
        return await handleVerify(request, env, url.hostname);
      }
      if (request.method === "POST" && url.pathname === "/setup") {
        return await handleSetup(request, env, url.origin);
      }
      return json({ error: "not found" }, 404);
    } catch (error) {
      if (error instanceof HttpError) {
        return json({ error: error.message }, error.status);
      }
      log("request_failed", { path: url.pathname, error: messageOf(error) });
      return json({ error: "internal error" }, 500);
    }
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const now = Date.now();
    await expirePending(env, now);
    await pruneModeration(env, now);
  },
} satisfies ExportedHandler<Env>;

// ---------- Telegram webhook ----------

async function handleWebhook(request: Request, env: Env, origin: string): Promise<Response> {
  const secret = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!constantTimeEqual(secret, env.WEBHOOK_SECRET)) {
    throw new HttpError(401, "unauthorized");
  }
  const update = (await request.json()) as Update;
  try {
    if (update.chat_join_request) {
      await onJoinRequest(env, update.chat_join_request, origin, Date.now());
    } else if (update.chat_member) {
      await onChatMember(env, update.chat_member, Date.now());
    } else if (update.message) {
      await onMessage(env, update.message);
    }
  } catch (error) {
    // Acknowledge anyway: a Telegram retry cannot fix a failed handler and would duplicate work.
    log("update_failed", { update_id: update.update_id, error: messageOf(error) });
  }
  return json({ ok: true });
}

async function onJoinRequest(
  env: Env,
  request: ChatJoinRequest,
  origin: string,
  now: number,
): Promise<void> {
  const chatId = String(request.chat.id);
  const userId = String(request.from.id);

  // Known spam accounts are declined before any challenge: our own offense record, then lols.bot.
  const [blocked, lols] = await Promise.all([isBlocked(env, userId, now), lolsBanned(userId)]);
  const declineReason = blocked ? "kitan_blocklist" : lols ? "lols_banned" : null;

  if (request.query_id) {
    // Guard bot path: Telegram shows the Mini App itself; we must answer within 10 seconds.
    const inserted = await env.DB.prepare(
      `INSERT OR IGNORE INTO attempts
         (chat_id, chat_title, user_id, delivery, query_id, status, created_at, expires_at, lols, error, decided_at)
       VALUES (?, ?, ?, 'guard', ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        chatId,
        request.chat.title ?? null,
        userId,
        request.query_id,
        declineReason ? "declined" : "pending",
        now,
        now + GUARD_TTL_MS,
        lols === null ? null : Number(lols),
        declineReason,
        declineReason ? now : null,
      )
      .run();
    if (!inserted.meta.changes) {
      return; // duplicate delivery
    }
    if (declineReason) {
      await callTelegram(env, "answerChatJoinRequestQuery", {
        chat_join_request_query_id: request.query_id,
        result: "decline",
      }).catch((error) => log("decline_failed", { error: messageOf(error) }));
      log("join_declined", { chat_id: chatId, user_id: userId, reason: declineReason });
      return;
    }
    try {
      await callTelegram(env, "sendChatJoinRequestWebApp", {
        chat_join_request_query_id: request.query_id,
        web_app_url: `${origin}/`,
      });
      log("join_challenge", { chat_id: chatId, user_id: userId, delivery: "guard" });
    } catch (error) {
      log("join_challenge_failed", { chat_id: chatId, user_id: userId, error: messageOf(error) });
      await setStatus(env, request.query_id, "query_id", "failed", now, messageOf(error));
      // Leave the decision to human admins rather than dropping a possibly real user.
      await callTelegram(env, "answerChatJoinRequestQuery", {
        chat_join_request_query_id: request.query_id,
        result: "queue",
      }).catch((answerError) => log("queue_failed", { error: messageOf(answerError) }));
    }
    return;
  }

  // DM path: the bot is not the chat's guard bot, so it messages the requester.
  if (declineReason) {
    await env.DB.prepare(
      `INSERT INTO attempts
         (chat_id, chat_title, user_id, delivery, status, created_at, expires_at, lols, error, decided_at)
       VALUES (?, ?, ?, 'dm', 'declined', ?, ?, ?, ?, ?)`,
    )
      .bind(chatId, request.chat.title ?? null, userId, now, now, lols === null ? null : Number(lols), declineReason, now)
      .run();
    await callTelegram(env, "declineChatJoinRequest", { chat_id: chatId, user_id: userId }).catch((error) =>
      log("decline_failed", { error: messageOf(error) }),
    );
    log("join_declined", { chat_id: chatId, user_id: userId, reason: declineReason });
    return;
  }
  const existing = await env.DB.prepare(
    `SELECT id FROM attempts
     WHERE chat_id = ? AND user_id = ? AND delivery = 'dm' AND status = 'pending' AND expires_at > ?`,
  )
    .bind(chatId, userId, now)
    .first();
  if (existing) {
    return;
  }
  const token = crypto.randomUUID().replace(/-/g, "");
  await env.DB.prepare(
    `INSERT INTO attempts (chat_id, chat_title, user_id, delivery, token, status, created_at, expires_at, lols)
     VALUES (?, ?, ?, 'dm', ?, 'pending', ?, ?, ?)`,
  )
    .bind(chatId, request.chat.title ?? null, userId, token, now, now + DM_TTL_MS, lols === null ? null : 0)
    .run();
  try {
    const lang = pickLang(request.from.language_code);
    const sent = await callTelegram<Message>(env, "sendMessage", {
      chat_id: request.user_chat_id,
      text: t(lang, "dm", { chat: request.chat.title ?? "" }),
      reply_markup: {
        inline_keyboard: [
          [{ text: t(lang, "dmButton"), web_app: { url: `${origin}/?token=${token}` } }],
        ],
      },
    });
    await env.DB.prepare(`UPDATE attempts SET message_id = ? WHERE token = ?`)
      .bind(sent.message_id, token)
      .run();
    log("join_challenge", { chat_id: chatId, user_id: userId, delivery: "dm" });
  } catch (error) {
    // Telegram refuses the DM for some users (privacy settings, or another admin wrote first).
    // Leave the request for the group's admins instead of declining a possibly real person.
    log("join_challenge_failed", { chat_id: chatId, user_id: userId, error: messageOf(error) });
    await setStatus(env, token, "token", "failed", now, messageOf(error));
  }
}

// Outcome labels for measurement: what approved members did afterwards.
async function onChatMember(env: Env, update: ChatMemberUpdated, now: number): Promise<void> {
  const status = update.new_chat_member.status;
  const column = status === "kicked" ? "banned_at" : status === "left" ? "left_at" : null;
  if (!column) {
    return;
  }
  await env.DB.prepare(
    `UPDATE attempts SET ${column} = ?
     WHERE chat_id = ? AND user_id = ? AND status = 'approved' AND ${column} IS NULL`,
  )
    .bind(now, String(update.chat.id), String(update.new_chat_member.user.id))
    .run();
}

async function onMessage(env: Env, message: Message): Promise<void> {
  if (message.chat.type === "group" || message.chat.type === "supergroup") {
    await onGroupMessage(env, message, Date.now());
    return;
  }
  if (message.chat.type !== "private" || !message.text?.startsWith("/start")) {
    return;
  }
  await callTelegram(env, "sendMessage", {
    chat_id: message.chat.id,
    text: t(pickLang(message.from?.language_code), "start"),
  });
}

// ---------- Mini App API ----------

interface ClientBody {
  initData?: string;
  token?: string;
  turnstileToken?: string;
  solveMs?: number;
}

async function readClient(
  request: Request,
  env: Env,
): Promise<{ body: ClientBody; data: InitData; attempt: Attempt }> {
  if (Number(request.headers.get("content-length") ?? "0") > 16 * 1024) {
    throw new HttpError(413, "Request too large.");
  }
  const body = (await request.json().catch(() => ({}))) as ClientBody;
  let data: InitData;
  try {
    data = await verifyInitData(body.initData ?? "", env.TELEGRAM_BOT_TOKEN, INIT_DATA_MAX_AGE_S);
  } catch (error) {
    log("initdata_rejected", { error: messageOf(error) });
    throw new HttpError(400, "Open this page from Telegram.");
  }

  const attempt = data.joinQueryId
    ? await env.DB.prepare(`SELECT * FROM attempts WHERE query_id = ?`)
        .bind(data.joinQueryId)
        .first<Attempt>()
    : body.token
      ? await env.DB.prepare(`SELECT * FROM attempts WHERE token = ?`)
          .bind(body.token)
          .first<Attempt>()
      : null;
  if (!attempt || attempt.user_id !== String(data.user.id)) {
    throw new HttpError(404, "No join request found. Request to join again.");
  }
  if (attempt.status === "approved") {
    throw new HttpError(409, "Already verified.");
  }
  if (attempt.status !== "pending" || attempt.expires_at < Date.now()) {
    throw new HttpError(410, "This request expired. Request to join again.");
  }
  return { body, data, attempt };
}

async function handleOpen(request: Request, env: Env): Promise<Response> {
  const { attempt } = await readClient(request, env);
  await env.DB.prepare(`UPDATE attempts SET opened_at = COALESCE(opened_at, ?) WHERE id = ?`)
    .bind(Date.now(), attempt.id)
    .run();
  return json({ chat_title: attempt.chat_title, expires_at: attempt.expires_at });
}

async function handleVerify(request: Request, env: Env, hostname: string): Promise<Response> {
  const { body, attempt } = await readClient(request, env);
  const now = Date.now();
  const solveMs = Number.isFinite(body.solveMs) ? Math.round(Number(body.solveMs)) : null;
  await env.DB.prepare(
    `UPDATE attempts SET tries = tries + 1, opened_at = COALESCE(opened_at, ?), solve_ms = COALESCE(?, solve_ms)
     WHERE id = ?`,
  )
    .bind(now, solveMs, attempt.id)
    .run();

  const failure = await verifyTurnstile(
    env.TURNSTILE_SECRET_KEY,
    body.turnstileToken,
    request.headers.get("cf-connecting-ip"),
    hostname,
  );
  if (failure) {
    await env.DB.prepare(`UPDATE attempts SET turnstile_error = ? WHERE id = ?`)
      .bind(failure, attempt.id)
      .run();
    log("turnstile_failed", { attempt: attempt.id, error: failure });
    throw new HttpError(400, "The check failed. Try again.");
  }

  // Claim the attempt so concurrent submissions approve at most once.
  const claimed = await env.DB.prepare(
    `UPDATE attempts SET status = 'approved', decided_at = ? WHERE id = ? AND status = 'pending' RETURNING id`,
  )
    .bind(now, attempt.id)
    .first();
  if (!claimed) {
    throw new HttpError(409, "Verification is already in progress.");
  }

  try {
    if (attempt.delivery === "guard") {
      await callTelegram(env, "answerChatJoinRequestQuery", {
        chat_join_request_query_id: attempt.query_id,
        result: "approve",
      });
    } else {
      await callTelegram(env, "approveChatJoinRequest", {
        chat_id: attempt.chat_id,
        user_id: attempt.user_id,
      });
    }
  } catch (error) {
    if (isGone(error)) {
      await env.DB.prepare(`UPDATE attempts SET status = 'failed', error = ? WHERE id = ?`)
        .bind(messageOf(error).slice(0, 300), attempt.id)
        .run();
      throw new HttpError(410, "This request is no longer available.");
    }
    await env.DB.prepare(`UPDATE attempts SET status = 'pending', decided_at = NULL WHERE id = ?`)
      .bind(attempt.id)
      .run();
    log("approve_failed", { attempt: attempt.id, error: messageOf(error) });
    throw new HttpError(502, "Telegram is unavailable. Try again.");
  }

  if (attempt.message_id) {
    await callTelegram(env, "deleteMessage", {
      chat_id: attempt.user_id,
      message_id: attempt.message_id,
    }).catch(() => {});
  }
  log("join_approved", { chat_id: attempt.chat_id, user_id: attempt.user_id, delivery: attempt.delivery });
  return json({ ok: true });
}

// ---------- Expiry ----------

export async function expirePending(env: Env, now: number): Promise<void> {
  const { results } = await env.DB.prepare(
    `UPDATE attempts SET status = 'expired', decided_at = ?
     WHERE id IN (SELECT id FROM attempts WHERE status = 'pending' AND expires_at <= ? LIMIT 50)
     RETURNING *`,
  )
    .bind(now, now)
    .all<Attempt>();
  for (const attempt of results) {
    if (attempt.delivery === "guard") {
      await callTelegram(env, "answerChatJoinRequestQuery", {
        chat_join_request_query_id: attempt.query_id,
        result: "decline",
      }).catch((error) => log("expire_answer_failed", { attempt: attempt.id, error: messageOf(error) }));
    } else {
      await callTelegram(env, "declineChatJoinRequest", {
        chat_id: attempt.chat_id,
        user_id: attempt.user_id,
      }).catch((error) => log("expire_decline_failed", { attempt: attempt.id, error: messageOf(error) }));
      if (attempt.message_id) {
        await callTelegram(env, "deleteMessage", {
          chat_id: attempt.user_id,
          message_id: attempt.message_id,
        }).catch(() => {});
      }
    }
    log("join_expired", { chat_id: attempt.chat_id, user_id: attempt.user_id, delivery: attempt.delivery });
  }
}

// ---------- Setup ----------

async function handleSetup(request: Request, env: Env, origin: string): Promise<Response> {
  const key = request.headers.get("x-setup-key") ?? "";
  if (!constantTimeEqual(key, env.WEBHOOK_SECRET)) {
    throw new HttpError(401, "unauthorized");
  }
  await callTelegram(env, "setWebhook", {
    url: `${origin}/telegram`,
    secret_token: env.WEBHOOK_SECRET,
    allowed_updates: ALLOWED_UPDATES,
    max_connections: 20,
  });
  const [me, webhook] = await Promise.all([
    callTelegram<Record<string, unknown>>(env, "getMe", {}),
    callTelegram<Record<string, unknown>>(env, "getWebhookInfo", {}),
  ]);
  // Which groups already route join requests to this bot as their guard bot.
  const { results: chats } = await env.DB.prepare(
    `SELECT DISTINCT chat_id, chat_title FROM attempts ORDER BY chat_id LIMIT 20`,
  ).all<{ chat_id: string; chat_title: string | null }>();
  // One group at a time: a Worker holds at most six open connections.
  const guards = [];
  for (const chat of chats) {
    guards.push(
      await (async () => {
      const [info, rights] = await Promise.all([
        callTelegram<{ guard_bot?: { username?: string } }>(env, "getChat", { chat_id: chat.chat_id }).catch(
          (error) => ({ error: messageOf(error) }),
        ),
        callTelegram<Record<string, unknown>>(env, "getChatMember", { chat_id: chat.chat_id, user_id: me.id }).catch(
          () => ({}) as Record<string, unknown>,
        ),
      ]);
      return {
        chat: chat.chat_title ?? chat.chat_id,
        guard_bot: "error" in info ? info.error : (info.guard_bot?.username ?? null),
        can_delete: rights.can_delete_messages === true,
        can_ban: rights.can_restrict_members === true,
      };
      })(),
    );
  }
  return json({
    bot: me.username,
    supports_join_request_queries: me.supports_join_request_queries ?? false,
    webhook: { url: webhook.url, pending: webhook.pending_update_count, last_error: webhook.last_error_message },
    guards,
  });
}

// ---------- helpers ----------

async function setStatus(
  env: Env,
  key: string,
  column: "query_id" | "token",
  status: Attempt["status"],
  now: number,
  error: string,
): Promise<void> {
  await env.DB.prepare(`UPDATE attempts SET status = ?, decided_at = ?, error = ? WHERE ${column} = ?`)
    .bind(status, now, error.slice(0, 300), key)
    .run();
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
