-- lols.bot verdict at join time (1 banned, 0 clean, NULL unknown) and the
-- number of messages an approved member has sent during probation.
ALTER TABLE attempts ADD COLUMN lols INTEGER;
ALTER TABLE attempts ADD COLUMN messages INTEGER NOT NULL DEFAULT 0;

-- Spam caught during probation. Two within 30 days, in any group, block the
-- account from every group Kitan serves.
CREATE TABLE offenses (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX offenses_user ON offenses (user_id, at);

-- Content hashes of probation messages for ten minutes, to spot the same
-- message posted across groups.
CREATE TABLE recent_messages (
  user_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  hash TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX recent_messages_user ON recent_messages (user_id, hash, at);
