-- How serious each offense was (probation.ts judge): mutes run 3 minutes to 24 hours by
-- score, and only a ban (score 5 or more) keeps an account from joining Kitan groups.
-- Rows from before were floods and bot promotions, all of them ad accounts.
ALTER TABLE offenses ADD COLUMN score INTEGER NOT NULL DEFAULT 5;
