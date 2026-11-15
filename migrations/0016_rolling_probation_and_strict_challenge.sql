-- A join request flagged by the profile audit can demand two Turnstile checks and
-- one arithmetic question, in a shuffled order (attempt.ts ChallengeState as JSON).
-- NULL keeps the normal single Turnstile check.
ALTER TABLE attempts ADD COLUMN challenge TEXT;

-- When this person's clean messages in this group arrived, as a JSON array of Unix
-- milliseconds. Probation lasts until seven of them fall within the last seven days;
-- deleted spam never counts, so it cannot buy its way out.
ALTER TABLE speakers ADD COLUMN recent_ats TEXT NOT NULL DEFAULT '[]';
