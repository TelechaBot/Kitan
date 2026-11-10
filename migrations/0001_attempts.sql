-- One row per join request: the pending state for the DM path and the
-- measurement record for every path (see README "Measurement").
CREATE TABLE attempts (
  id INTEGER PRIMARY KEY,
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  delivery TEXT NOT NULL,          -- guard | dm
  query_id TEXT UNIQUE,            -- guard path
  token TEXT UNIQUE,               -- dm path
  message_id INTEGER,              -- dm path: the challenge message
  status TEXT NOT NULL,            -- pending | approved | expired | failed
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  opened_at INTEGER,               -- Mini App first opened
  tries INTEGER NOT NULL DEFAULT 0,
  solve_ms INTEGER,                -- client-reported: page open -> Turnstile solved
  turnstile_error TEXT,
  decided_at INTEGER,
  left_at INTEGER,                 -- label: left after approval
  banned_at INTEGER                -- label: kicked after approval
);

CREATE INDEX attempts_pending ON attempts (status, expires_at);
CREATE INDEX attempts_member ON attempts (chat_id, user_id, created_at);
