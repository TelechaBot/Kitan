export interface Env {
  DB: D1Database;
  AI: Ai;
  TELEGRAM_BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  TURNSTILE_SITE_KEY: string;
  TURNSTILE_SECRET_KEY: string;
}

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
}

export interface TelegramChat {
  id: number;
  type?: string;
  title?: string;
  username?: string;
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
  bio?: string;
  query_id?: string;
}

export interface ChatMemberUpdated {
  chat: TelegramChat;
  from: TelegramUser; // who made the change: the joiner, an admin, or a bot that approved them
  old_chat_member: { status: string; user: TelegramUser };
  new_chat_member: { status: string; user: TelegramUser };
  invite_link?: { name?: string; creates_join_request?: boolean; creator?: TelegramUser };
  via_join_request?: boolean;
}

export interface InlineButton {
  text?: string;
  url?: string;
  login_url?: unknown;
}

export interface Message {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  sender_chat?: TelegramChat; // set when the message is sent on behalf of a chat or channel
  is_automatic_forward?: boolean; // a post from the group's linked channel
  text?: string;
  caption?: string;
  entities?: { type: string }[];
  caption_entities?: { type: string }[];
  forward_origin?: unknown;
  external_reply?: unknown;
  story?: unknown;
  via_bot?: { username?: string };
  reply_markup?: { inline_keyboard?: InlineButton[][] };
  photo?: PhotoSize[];
  // Other content; each media kind may carry a small preview image.
  video?: Media;
  animation?: Media;
  document?: Media & { file_name?: string };
  sticker?: Media & { emoji?: string; set_name?: string };
  video_note?: Media;
  voice?: Media;
  audio?: Media;
  contact?: { phone_number: string; first_name?: string; last_name?: string; user_id?: number };
  edit_date?: number;
}

export interface PhotoSize {
  file_id: string;
  width: number;
  height: number;
}

export interface Media {
  file_id: string;
  duration?: number;
  mime_type?: string;
  thumbnail?: PhotoSize;
}

export interface Update {
  update_id: number;
  chat_join_request?: ChatJoinRequest;
  chat_member?: ChatMemberUpdated;
  message?: Message;
  edited_message?: Message;
}
