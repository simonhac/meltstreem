/**
 * Broadcast station code → display name, backed by the D1 `station_names` table (seeded in
 * migrations/0007). The "Every Mention" webhook doesn't carry the station for radio/TV — `authorName`
 * is either the station or the reporter, and the real station name lives only on the broadcast viewer.
 * `src/lib/meltwater/station-resolve.ts` extracts the numeric code from the viewer token; this maps that
 * code to a name (and lets Browser Rendering auto-populate new codes). Adding a station is now an INSERT.
 */

/** Station name for a Meltwater broadcast code, or null if not in the table. */
export async function stationNameForCode(db: D1Database, code: string | null | undefined): Promise<string | null> {
  if (!code) return null;
  const row = await db.prepare("SELECT name FROM station_names WHERE code = ?").bind(code).first<{ name: string }>();
  return row?.name ?? null;
}

/** Record a code→name mapping discovered by Browser Rendering (idempotent). */
export async function upsertStationName(db: D1Database, code: string, name: string, now: number): Promise<void> {
  await db
    .prepare("INSERT OR REPLACE INTO station_names (code, name, resolved_at) VALUES (?, ?, ?)")
    .bind(code, name, now)
    .run();
}
