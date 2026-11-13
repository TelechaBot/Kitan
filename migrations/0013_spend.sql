-- Neurons spent on Workers AI per hour (estimated per call, classify.ts NEURONS), so the
-- shadow models stay within the free plan's allowance over any 24 hours.
CREATE TABLE spend (
  hour INTEGER PRIMARY KEY, -- Unix time / 3,600,000
  neurons REAL NOT NULL
);
