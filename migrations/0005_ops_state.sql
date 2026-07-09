-- Small key/value store for operational state that must survive between requests and cron runs.
-- Currently backs the ingestion heartbeat's alert bookkeeping (the last-alerted timestamp) so a
-- persistent stall pages once per re-alert window instead of on every cron tick.
CREATE TABLE IF NOT EXISTS ops_state (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL       -- epoch ms
);
