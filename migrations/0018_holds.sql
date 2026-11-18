-- A direct joiner whose profile looks like an ad is muted with a strict-check appeal and
-- removed at kick_at unless they pass it first (moderation.ts sweepHolds). kicked_at marks
-- the removal, after which the appeal can no longer lift anything.
ALTER TABLE appeals ADD COLUMN kick_at INTEGER;
ALTER TABLE appeals ADD COLUMN kicked_at INTEGER;
CREATE INDEX appeals_holds ON appeals (kick_at) WHERE kick_at IS NOT NULL AND kicked_at IS NULL AND passed_at IS NULL;
