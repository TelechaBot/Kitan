-- One row per admin and group a notice was sent to, so a notice is never sent twice.
CREATE TABLE admin_notices (
  notice TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  via TEXT NOT NULL,     -- dm | ephemeral | failed
  at INTEGER NOT NULL,
  PRIMARY KEY (notice, chat_id, user_id)
);
