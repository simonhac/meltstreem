/** Tiny key/value store for operational state that outlives a single request (e.g. the ingestion
 * heartbeat's alert bookkeeping). Backed by the `ops_state` table (migration 0005). */
export class OpsState {
  constructor(private db: D1Database) {}

  async get(key: string): Promise<string | null> {
    const row = await this.db.prepare(`SELECT value FROM ops_state WHERE key = ?`).bind(key).first<{ value: string }>();
    return row?.value ?? null;
  }

  /** Convenience for epoch-ms / numeric values; null when absent or unparseable. */
  async getNumber(key: string): Promise<number | null> {
    const v = await this.get(key);
    if (v === null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  /** Upsert. `now` is the caller's clock (epoch ms), stored as updated_at. */
  async set(key: string, value: string, now: number): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO ops_state (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .bind(key, value, now)
      .run();
  }

  async delete(key: string): Promise<void> {
    await this.db.prepare(`DELETE FROM ops_state WHERE key = ?`).bind(key).run();
  }
}
