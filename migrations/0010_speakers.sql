-- Behaviour-based review. Newcomers are always reviewed; anyone else skips review
-- once active across Kitan groups and their behaviour is not anomalous (needsReview
-- in probation.ts). Replaces `newcomers`, whose rows carry over.

-- Who has spoken or joined in each group.
CREATE TABLE speakers (
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  joined_at INTEGER, -- last time Kitan saw them join; null if they were here before
  PRIMARY KEY (chat_id, user_id)
);
CREATE INDEX speakers_user ON speakers (user_id);
INSERT INTO speakers (chat_id, user_id, joined_at)
  SELECT chat_id, user_id, joined_at FROM newcomers;
DROP TABLE newcomers;

-- One behaviour sketch per account across all Kitan groups (trajectory.ts, JSON).
CREATE TABLE trajectories (
  user_id TEXT PRIMARY KEY,
  messages INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  body TEXT NOT NULL
);
CREATE INDEX trajectories_messages ON trajectories (messages);

-- When counting began: someone Kitan never saw join who spoke soon after this is
-- presumed an old regular rather than a newcomer.
CREATE TABLE meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
INSERT INTO meta (key, value) VALUES ('counting_since', CAST(strftime('%s', 'now') AS INTEGER) * 1000);

-- Trained models, e.g. the isolation forest over trajectories (JSON).
CREATE TABLE models (
  name TEXT PRIMARY KEY,
  trained_at INTEGER NOT NULL,
  rows INTEGER NOT NULL,
  body TEXT NOT NULL
);
