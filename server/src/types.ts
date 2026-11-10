export type MemberState = "probation" | "member" | "trusted" | "left" | "banned";

export type SignalName =
  | "link"
  | "mention"
  | "duplicate"
  | "flood"
  | "media_only"
  | "external";

export interface Signal {
  name: SignalName;
  weight: number;
  detail: string;
}

export type Action = "allow" | "review" | "restrict" | "remove";

export interface Verdict {
  action: Action;
  risk: number;
  reasons: Signal[];
}

export interface SignalInput {
  text: string;
  state: MemberState;
  recentCount: number;
  shortCount: number;
  duplicateCount: number;
  mediaOnly: boolean;
  external: boolean;
  mentions: number;
}

export interface MemberRow {
  chat_id: string;
  user_id: string;
  state: MemberState;
  observed: number;
  offenses: number;
  first_seen: number;
  last_seen: number;
}

export interface UserRow {
  user_id: string;
  offenses: number;
  last_offense_at: number;
  last_seen: number;
}

export interface InitData {
  user: TelegramUser;
  chat?: TelegramChat;
  authDate: number;
}

export interface PendingRow {
  token: string;
  chat_id: string;
  user_id: string;
  message_id: string;
  created_at: number;
  expires_at: number;
}

export interface Settings {
  antiSpam: boolean;
}

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
}

export interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  caption?: string;
  photo?: unknown[];
  video?: unknown;
  document?: unknown;
  voice?: unknown;
  video_note?: unknown;
  audio?: unknown;
  animation?: unknown;
  sticker?: unknown;
  external_reply?: unknown;
  forward_origin?: unknown;
}

export interface TelegramChatJoinRequest {
  chat: TelegramChat;
  from: TelegramUser;
  user_chat_id: number;
  date: number;
  bio?: string;
}

export interface TelegramChatMember {
  status: string;
  user: TelegramUser;
}

export interface TelegramChatMemberUpdated {
  chat: TelegramChat;
  from: TelegramUser;
  old_chat_member: TelegramChatMember;
  new_chat_member: TelegramChatMember;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  data?: string;
  message?: {
    message_id: number;
    chat: TelegramChat;
  } | null;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  chat_join_request?: TelegramChatJoinRequest;
  chat_member?: TelegramChatMemberUpdated;
  callback_query?: TelegramCallbackQuery;
}
