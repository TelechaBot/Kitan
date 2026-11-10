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
