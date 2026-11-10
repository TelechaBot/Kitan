import { type Attempt, type Refusal, openForUser } from "./attempt";
import { constantTimeEqual, verifyInitData } from "./crypto";
import { chatsSeen, findAttempt, labelMember, markOpened, recordTry, recordTurnstileError } from "./db";
import { pickLang, t } from "./i18n";
import { advance, expirePending, onJoinRequest, resumeFor } from "./join";
import { onGroupMessage, pruneModeration } from "./moderation";
import { renderPage } from "./page";
import { callTelegram, isGone, log, messageOf } from "./telegram";
import { verifyTurnstile } from "./turnstile";
import type { Env, Message, Update } from "./types";

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
    const route = `${request.method} ${url.pathname}`;
    try {
      switch (route) {
        case "GET /":
          return new Response(renderPage(env.TURNSTILE_SITE_KEY), {
            headers: {
              "content-type": "text/html; charset=utf-8",
              "cache-control": "no-store",
              "x-content-type-options": "nosniff",
              "referrer-policy": "no-referrer",
            },
          });
        case "GET /health":
          return json({ ok: true });
        case "POST /telegram":
          return await handleWebhook(request, env, url.origin);
        case "POST /api/open":
          return await handleOpen(request, env);
        case "POST /api/verify":
          return await handleVerify(request, env, url.hostname);
        case "POST /setup":
          requireKey(request, env);
          return await handleSetup(env, url.origin);
        case "POST /status":
          requireKey(request, env);
          return await handleStatus(env);
        default:
          return json({ error: "not found" }, 404);
      }
    } catch (error) {
      if (error instanceof HttpError) {
        return json({ error: error.message }, error.status);
      }
      log("request_failed", { route, error: messageOf(error) });
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
  const now = Date.now();
  try {
    if (update.chat_join_request) {
      await onJoinRequest(env, update.chat_join_request, origin, now);
    } else if (update.chat_member) {
      const { chat, new_chat_member } = update.chat_member;
      if (new_chat_member.status === "kicked" || new_chat_member.status === "left") {
        const outcome = new_chat_member.status === "kicked" ? "banned" : "left";
        await labelMember(env.DB, String(chat.id), String(new_chat_member.user.id), outcome, now);
      }
    } else if (update.message) {
      await onMessage(env, update.message, origin, now);
    }
  } catch (error) {
    // Acknowledge anyway: a Telegram retry cannot fix a failed handler and would duplicate work.
    log("update_failed", { update_id: update.update_id, error: messageOf(error) });
  }
  return json({ ok: true });
}

async function onMessage(env: Env, message: Message, origin: string, now: number): Promise<void> {
  if (message.chat.type === "group" || message.chat.type === "supergroup") {
    await onGroupMessage(env, message, now);
    return;
  }
  if (message.chat.type !== "private" || !message.from || !message.text?.startsWith("/start")) return;
  // Someone the bot could not message first has now opened the chat: send their checks.
  const lang = pickLang(message.from.language_code);
  if ((await resumeFor(env, message.from.id, lang, origin, now)) > 0) return;
  await callTelegram(env, "sendMessage", { chat_id: message.chat.id, text: t(lang, "start") });
}

// ---------- Mini App API ----------

interface ClientBody {
  initData?: string;
  token?: string;
  turnstileToken?: string;
  solveMs?: number;
}

// Authenticates the Mini App request and returns the user's pending attempt.
async function readClient(request: Request, env: Env): Promise<{ body: ClientBody; attempt: Attempt }> {
  if (Number(request.headers.get("content-length") ?? "0") > 16 * 1024) {
    throw new HttpError(413, "Request too large.");
  }
  const body = (await request.json().catch(() => ({}))) as ClientBody;
  const data = await verifyInitData(body.initData ?? "", env.TELEGRAM_BOT_TOKEN, INIT_DATA_MAX_AGE_S).catch(
    (error) => {
      log("initdata_rejected", { error: messageOf(error) });
      throw new HttpError(400, "Open this page from Telegram.");
    },
  );
  const key = data.joinQueryId ? { queryId: data.joinQueryId } : body.token ? { token: body.token } : null;
  const attempt = key ? await findAttempt(env.DB, key) : null;
  if (!attempt || attempt.userId !== String(data.user.id)) {
    throw new HttpError(404, "No join request found. Request to join again.");
  }
  const closed = openForUser(attempt, Date.now());
  if (closed) throw refusal(closed);
  return { body, attempt };
}

function refusal(reason: Refusal): HttpError {
  return reason === "already_verified"
    ? new HttpError(409, "Already verified.")
    : new HttpError(410, "This request expired. Request to join again.");
}

async function handleOpen(request: Request, env: Env): Promise<Response> {
  const { attempt } = await readClient(request, env);
  await markOpened(env.DB, attempt.id, Date.now());
  return json({ chat_title: attempt.chatTitle, expires_at: attempt.expiresAt });
}

async function handleVerify(request: Request, env: Env, hostname: string): Promise<Response> {
  const { body, attempt } = await readClient(request, env);
  const now = Date.now();
  const solveMs = Number.isFinite(body.solveMs) ? Math.round(Number(body.solveMs)) : null;
  await recordTry(env.DB, attempt.id, now, solveMs);

  const failure = await verifyTurnstile(
    env.TURNSTILE_SECRET_KEY,
    body.turnstileToken,
    request.headers.get("cf-connecting-ip"),
    hostname,
  );
  if (failure) {
    await recordTurnstileError(env.DB, attempt.id, failure);
    log("turnstile_failed", { attempt: attempt.id, error: failure });
    throw new HttpError(400, "The check failed. Try again.");
  }

  const outcome = await advance(env, attempt, { type: "verified", at: now });
  if (!outcome.ok) throw refusal(outcome.reason);
  if (outcome.error !== undefined) {
    const gone = isGone(outcome.error);
    await advance(env, outcome.next, { type: "approve_failed", gone, error: messageOf(outcome.error), at: now });
    log("approve_failed", { attempt: attempt.id, error: messageOf(outcome.error) });
    throw gone
      ? new HttpError(410, "This request is no longer available.")
      : new HttpError(502, "Telegram is unavailable. Try again.");
  }
  log("join_approved", { chat_id: attempt.chatId, user_id: attempt.userId, delivery: attempt.delivery.kind });
  return json({ ok: true });
}

// ---------- Operator endpoints ----------

function requireKey(request: Request, env: Env): void {
  if (!constantTimeEqual(request.headers.get("x-setup-key") ?? "", env.WEBHOOK_SECRET)) {
    throw new HttpError(401, "unauthorized");
  }
}

async function handleSetup(env: Env, origin: string): Promise<Response> {
  await callTelegram(env, "setWebhook", {
    url: `${origin}/telegram`,
    secret_token: env.WEBHOOK_SECRET,
    allowed_updates: ALLOWED_UPDATES,
    max_connections: 20,
  });
  return handleStatus(env);
}

// The bot's capabilities, webhook health, and per-group guard and admin rights.
async function handleStatus(env: Env): Promise<Response> {
  const [me, webhook] = await Promise.all([
    callTelegram<{ id: number; username: string; supports_join_request_queries?: boolean }>(env, "getMe", {}),
    callTelegram<{ url: string; pending_update_count: number; last_error_message?: string }>(env, "getWebhookInfo", {}),
  ]);
  const groups = [];
  // One group at a time: a Worker holds at most six open connections.
  for (const chat of await chatsSeen(env.DB)) {
    const [info, rights] = await Promise.all([
      callTelegram<{ guard_bot?: { username?: string } }>(env, "getChat", { chat_id: chat.chat_id }),
      callTelegram<{ can_delete_messages?: boolean; can_restrict_members?: boolean }>(env, "getChatMember", {
        chat_id: chat.chat_id,
        user_id: me.id,
      }),
    ]).catch((error) => [{ error: messageOf(error) }, {}] as const);
    groups.push({
      chat: chat.chat_title ?? chat.chat_id,
      guard_bot: "error" in info ? info.error : (info.guard_bot?.username ?? null),
      can_delete: "can_delete_messages" in rights && rights.can_delete_messages === true,
      can_ban: "can_restrict_members" in rights && rights.can_restrict_members === true,
    });
  }
  return json({
    bot: me.username,
    supports_join_request_queries: me.supports_join_request_queries ?? false,
    webhook: { url: webhook.url, pending: webhook.pending_update_count, last_error: webhook.last_error_message },
    groups,
  });
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}
