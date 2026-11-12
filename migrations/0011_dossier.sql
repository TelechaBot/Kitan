-- Every group Kitan sees, by any update, not only those with join requests.
CREATE TABLE chats (
  chat_id TEXT PRIMARY KEY,
  title TEXT,
  username TEXT,
  type TEXT,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
INSERT INTO chats (chat_id, title, first_seen, last_seen)
  SELECT chat_id, max(chat_title), min(created_at), max(created_at) FROM attempts GROUP BY chat_id;

-- A profile per person under review, read from Telegram at join or at first review and
-- refreshed weekly: what the model sees next to each message (classify.ts, Dossier).
CREATE TABLE profiles (
  user_id TEXT PRIMARY KEY,
  name TEXT,
  username TEXT,
  bio TEXT,
  personal_chat TEXT,
  has_photo INTEGER,
  premium INTEGER,
  lang TEXT,
  checked_at INTEGER NOT NULL
);
