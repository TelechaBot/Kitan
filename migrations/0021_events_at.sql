-- The hourly prune (DELETE FROM events WHERE at <= ?) scanned the whole table, ~48k rows a run.
CREATE INDEX events_at ON events (at);
