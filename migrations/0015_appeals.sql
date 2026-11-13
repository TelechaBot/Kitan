-- A muted newcomer can lift their own mute once in 30 days by passing the check again
-- (appeal.ts). Each mute gets one row; passed ones are the closest thing to a label for
-- the rules' false positives.
CREATE TABLE appeals (
  token TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  rule TEXT NOT NULL,
  score INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  until INTEGER NOT NULL, -- when the mute ends anyway
  opened_at INTEGER,
  tries INTEGER NOT NULL DEFAULT 0,
  solve_ms INTEGER,
  passed_at INTEGER
);
CREATE INDEX appeals_user ON appeals (user_id, passed_at);
