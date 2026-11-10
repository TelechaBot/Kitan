-- Why an attempt failed (Telegram error text), for diagnosis and measurement.
ALTER TABLE attempts ADD COLUMN error TEXT;
