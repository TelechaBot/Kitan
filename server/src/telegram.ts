import type {
  TelegramChatMember,
  TelegramUpdate,
} from "./types";

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  web_app?: { url: string };
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

export const ALLOW_ALL: Record<string, boolean> = {
  can_send_messages: true,
  can_send_audios: true,
  can_send_documents: true,
  can_send_photos: true,
  can_send_videos: true,
  can_send_video_notes: true,
  can_send_voice_notes: true,
  can_send_polls: true,
  can_send_other_messages: true,
  can_add_web_page_previews: true,
  can_change_info: false,
  can_invite_users: true,
  can_pin_messages: false,
  can_manage_topics: false,
};

export const DENY_ALL: Record<string, boolean> = {
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
  can_change_info: false,
  can_invite_users: false,
  can_pin_messages: false,
  can_manage_topics: false,
};

export class TelegramError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "TelegramError";
  }
}

export class TelegramClient {
  constructor(
    private readonly token: string,
    private readonly apiBase = "https://api.telegram.org",
  ) {}

  private async call<T>(
    method: string,
    payload: Record<string, unknown>,
    timeoutMs = 10_000,
  ): Promise<T> {
    const response = await fetch(`${this.apiBase}/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await response.json()) as {
      ok: boolean;
      result: T;
      description?: string;
      error_code?: number;
      parameters?: { retry_after?: number };
    };
    if (!response.ok || !body.ok) {
      throw new TelegramError(
        body.description ?? `Telegram ${method} failed`,
        body.error_code ?? response.status,
        body.parameters?.retry_after,
      );
    }
    return body.result;
  }

  getMe(): Promise<{ id: number; username?: string }> {
    return this.call("getMe", {});
  }

  deleteWebhook(): Promise<boolean> {
    return this.call("deleteWebhook", {});
  }

  getUpdates(offset: number, timeoutSec: number): Promise<TelegramUpdate[]> {
    return this.call(
      "getUpdates",
      {
        ...(offset > 0 ? { offset } : {}),
        timeout: timeoutSec,
        allowed_updates: [
          "message",
          "edited_message",
          "chat_join_request",
          "chat_member",
          "callback_query",
        ],
      },
      timeoutSec * 1000 + 10_000,
    );
  }

  sendMessage(
    chatId: number | string,
    text: string,
    replyMarkup?: InlineKeyboardMarkup,
  ): Promise<{ message_id: number }> {
    return this.call("sendMessage", {
      chat_id: chatId,
      text,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }

  deleteMessage(
    chatId: number | string,
    messageId: number,
  ): Promise<unknown> {
    return this.call("deleteMessage", {
      chat_id: chatId,
      message_id: messageId,
    });
  }

  restrictChatMember(
    chatId: string,
    userId: string,
    permissions: Record<string, boolean>,
    untilDate?: number,
  ): Promise<unknown> {
    return this.call("restrictChatMember", {
      chat_id: chatId,
      user_id: userId,
      permissions,
      ...(untilDate ? { until_date: untilDate } : {}),
    });
  }

  banChatMember(chatId: string, userId: string): Promise<unknown> {
    return this.call("banChatMember", {
      chat_id: chatId,
      user_id: userId,
      revoke_messages: false,
    });
  }

  unbanChatMember(chatId: string, userId: string): Promise<unknown> {
    return this.call("unbanChatMember", {
      chat_id: chatId,
      user_id: userId,
      only_if_banned: true,
    });
  }

  getChatMember(
    chatId: string,
    userId: string,
  ): Promise<TelegramChatMember> {
    return this.call("getChatMember", {
      chat_id: chatId,
      user_id: userId,
    });
  }

  answerCallbackQuery(
    callbackQueryId: string,
    text?: string,
  ): Promise<unknown> {
    return this.call("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
    });
  }

  approveChatJoinRequest(chatId: string, userId: string): Promise<unknown> {
    return this.call("approveChatJoinRequest", {
      chat_id: chatId,
      user_id: userId,
    });
  }

  declineChatJoinRequest(chatId: string, userId: string): Promise<unknown> {
    return this.call("declineChatJoinRequest", {
      chat_id: chatId,
      user_id: userId,
    });
  }
}
