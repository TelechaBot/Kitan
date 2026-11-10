-- DM challenges Telegram refused were recorded as failed; they are now
-- "unreachable" so the person can resume by starting the bot.
-- instr, not LIKE: D1 rejects LIKE patterns this long.
UPDATE attempts SET status = 'unreachable'
WHERE status = 'failed' AND delivery = 'dm' AND token IS NOT NULL
  AND (instr(error, 'Forbidden: bot can''t initiate conversation') > 0
       OR instr(error, 'Forbidden: bot was blocked by the user') > 0);
