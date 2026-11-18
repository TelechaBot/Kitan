-- Ad profiles kept out of a group, by either door (db.ts recordTurnedAway): the next
-- attempt within a week gets the strict check instead of being turned away again.
CREATE TABLE turned_away (
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  door TEXT NOT NULL, -- request: join request declined | join: direct joiner removed
  at INTEGER NOT NULL
);
CREATE INDEX turned_away_member ON turned_away (chat_id, user_id, at);

-- An appeal can demand the strict check (attempt.ts ChallengeState as JSON): a direct
-- joiner muted for an ad profile lifts the mute with two Turnstile checks and one sum.
ALTER TABLE appeals ADD COLUMN challenge TEXT;
