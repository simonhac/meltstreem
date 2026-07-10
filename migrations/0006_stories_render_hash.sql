-- Cache the rendered card's hash per story so the /admin/redecode backfill can detect when a
-- re-render under the current parser/outlets/format actually changes a card, and chat.update only
-- those (idempotent re-runs). NULL for rows posted before this column existed → redecode treats them
-- as changed on the first pass, then fills the hash in.
ALTER TABLE stories ADD COLUMN render_hash TEXT;
