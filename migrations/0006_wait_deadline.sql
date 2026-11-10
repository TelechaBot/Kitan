-- Unreachable attempts now end an hour after the DM was refused (WAIT_TTL_MS),
-- so nobody stays locked out of asking again.
UPDATE attempts SET expires_at = COALESCE(decided_at, created_at) + 3600000
WHERE status = 'unreachable';
