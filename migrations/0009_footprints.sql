-- Everyone who joins a group, however they got in (Kitan, another bot, an admin,
-- an invite link). Probation runs on this, not on Kitan's own approvals.
CREATE TABLE newcomers (
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  messages INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chat_id, user_id)
);
CREATE INDEX newcomers_user ON newcomers (user_id, joined_at);

-- Footprints: what newcomers did and what Kitan concluded, kept 14 days so an
-- incident can be reconstructed and detectors can be scored afterwards.
-- kind: join_request | join | profile | message | edit | verdict | action | leave
CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL -- JSON
);
CREATE INDEX events_chat ON events (chat_id, at);
CREATE INDEX events_user ON events (user_id, at);
