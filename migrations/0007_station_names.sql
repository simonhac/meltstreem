-- Broadcast station code → display name, moved out of code (was STATION_BY_CODE in stations.ts) into
-- D1 so a station can be added/corrected with an INSERT, no deploy. `resolved_at` is set when a name is
-- auto-discovered via Browser Rendering; NULL for the hand-seeded rows below.
CREATE TABLE IF NOT EXISTS station_names (
  code        TEXT PRIMARY KEY,   -- Meltwater numeric broadcast code (from the mediaView token)
  name        TEXT NOT NULL,
  resolved_at INTEGER             -- epoch ms when auto-resolved; NULL if seeded
);

-- Seed: the codes previously hard-coded, plus three confirmed by rendering the viewer (Browser
-- Rendering turns the internal code into the public code + title, e.g. 8645 → AURAD702 → "702 ABC Sydney").
INSERT OR IGNORE INTO station_names (code, name) VALUES
  ('8650',  '4BC 1116 News Talk'),
  ('8670',  '6PR 882 News Talk'),
  ('7670',  'ABC RN'),
  ('11655', 'ABC Kimberley'),
  ('12760', 'ABC Esperance'),
  ('15920', '7BU 558 AM'),
  ('15925', 'Sea FM 101.7'),
  ('15935', '98.9 7AD FM'),
  ('15950', '7XS West Coast Radio Tasmania'),
  ('8645',  '702 ABC Sydney'),
  ('15670', '2CC'),
  ('12240', 'ABC Central Coast NSW');
