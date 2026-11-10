export interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  TURNSTILE_SITE_KEY: string;
  TURNSTILE_SECRET_KEY: string;
}

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  language_code?: string;
}

export interface TelegramChat {
  id: number;
  type?: string;
  title?: string;
}

export interface InitData {
  user: TelegramUser;
  joinQueryId?: string;
}

export interface ChatJoinRequest {
  chat: TelegramChat;
  from: TelegramUser;
  user_chat_id: number;
  date: number;
  query_id?: string;
}

export interface ChatMemberUpdated {
  chat: TelegramChat;
  new_chat_member: { status: string; user: TelegramUser };
}

export interface Message {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  caption?: string;
  entities?: { type: string }[];
  caption_entities?: { type: string }[];
  forward_origin?: unknown;
  external_reply?: unknown;
  story?: unknown;
  via_bot?: unknown;
  reply_markup?: unknown;
}

export interface Update {
  update_id: number;
  chat_join_request?: ChatJoinRequest;
  chat_member?: ChatMemberUpdated;
  message?: Message;
}

export interface Attempt {
  id: number;
  chat_id: string;
  chat_title: string | null;
  user_id: string;
  delivery: "guard" | "dm";
  query_id: string | null;
  token: string | null;
  message_id: number | null;
  status: "pending" | "approved" | "expired" | "failed" | "declined";
  expires_at: number;
}
