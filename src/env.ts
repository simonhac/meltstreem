export interface Env {
  /** D1 database — webhook_events + seen_mentions (see migrations/). */
  DB: D1Database;

  // --- non-secret vars (wrangler.jsonc) ---
  /** "true" to actually post to Slack. Stays "false" until the payload is confirmed + a bot token is wired. */
  POSTING_ENABLED: string;

  // --- secrets (.dev.vars locally; `wrangler secret put` in prod) ---
  /** Path token guarding POST /webhooks/meltwater/:token */
  WEBHOOK_SHARED_SECRET?: string;
  /** Query-key guarding /inspect and /api/webhooks/* */
  INSPECT_KEY?: string;
  /** Slack bot token (xoxb-…) with chat:write */
  SLACK_BOT_TOKEN?: string;
  /** Default Slack channel id/name for the trial feed */
  SLACK_DEFAULT_CHANNEL?: string;
  /** Query-key guarding POST /admin/replay (reparse + repost archived events). */
  REPLAY_KEY?: string;

  // --- ingestion heartbeat (all optional; sensible defaults in src/lib/heartbeat.ts) ---
  /** Alert if no webhook has arrived in this many hours (default 3). */
  HEARTBEAT_MAX_SILENCE_HOURS?: string;
  /** While a stall persists, re-alert at most once per this many hours (default 6). */
  HEARTBEAT_REALERT_HOURS?: string;
  /** Channel for heartbeat alerts; falls back to SLACK_DEFAULT_CHANNEL. */
  SLACK_ALERT_CHANNEL?: string;
}
