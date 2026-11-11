-- How many recent checks this person let lapse in this group before this one;
-- each lapse gives the next check more time (see patience in attempt.ts).
ALTER TABLE attempts ADD COLUMN misses INTEGER NOT NULL DEFAULT 0;
