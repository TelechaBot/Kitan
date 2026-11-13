import type { Env } from "./types";

class TelegramError extends Error {}

export function log(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields }));
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function callTelegram<T = unknown>(
  env: Env,
  method: string,
  params: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(8_000),
  });
  const body = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    result?: T;
    description?: string;
  };
  if (!body.ok) {
    throw new TelegramError(`${method}: ${body.description ?? response.status}`);
  }
  return body.result as T;
}

// Everything a member may send, all off (a mute) or all on (lifting it; the group's own
// defaults still apply on top).
export function sendPermissions(allowed: boolean) {
  return {
    can_send_messages: allowed,
    can_send_audios: allowed,
    can_send_documents: allowed,
    can_send_photos: allowed,
    can_send_videos: allowed,
    can_send_video_notes: allowed,
    can_send_voice_notes: allowed,
    can_send_polls: allowed,
    can_send_other_messages: allowed,
    can_add_web_page_previews: allowed,
  };
}

let username: Promise<string> | null = null;

// Looked up once per Worker instance, so self-hosted copies link to their own bot.
export function botUsername(env: Env): Promise<string> {
  username ??= callTelegram<{ username: string }>(env, "getMe", {})
    .then((me) => me.username)
    .catch((error) => {
      username = null;
      throw error;
    });
  return username;
}

// Telegram forbids the bot to start a conversation with this person: their
// privacy settings, another admin wrote to them first, or they blocked the bot.
// Once they press Start in the bot, messages go through.
export function isRefused(error: unknown): boolean {
  return (
    error instanceof TelegramError &&
    /Forbidden: (bot can't initiate conversation|bot was blocked by the user)/.test(error.message)
  );
}

// The join request or query no longer exists: answered elsewhere, withdrawn, or too old.
export function isGone(error: unknown): boolean {
  return (
    error instanceof TelegramError &&
    /HIDE_REQUESTER_MISSING|USER_ALREADY_PARTICIPANT|JOIN_REQUEST|QUERY_ID_INVALID|too old|not found/i.test(
      error.message,
    )
  );
}
