import type { Env } from "@/env";

/** A single config check. `detail` is safe to surface publicly — it NEVER contains a secret value. */
export interface ConfigCheck {
  /** The env var this check concerns. */
  name: string;
  /** True when the value is present and well-formed. */
  ok: boolean;
  /** "error" fails `configOk`; "warn" is advisory. */
  severity: "error" | "warn";
  /** Human-readable reason when not ok (no secret values). */
  detail?: string;
}

/** URL scheme, whitespace, or slashes in a value that is supposed to be a bare path/query token. */
const TOKEN_CONTAMINATION = /:\/\/|\s|\//;

/** Bare tokens (WEBHOOK_SHARED_SECRET, REPLAY_KEY): a guess-resistant string, not a URL/path. */
function tokenCheck(name: string, val: string | undefined, min = 16): ConfigCheck {
  if (!val) return { name, ok: false, severity: "error", detail: "missing" };
  // The classic footgun: pasting the whole webhook URL instead of just the token — this value is
  // matched against the URL's *path segment*, so a URL/slash/space here silently 403s every delivery.
  if (TOKEN_CONTAMINATION.test(val)) {
    return { name, ok: false, severity: "error", detail: "expected a bare token but found a URL, slash, or whitespace" };
  }
  if (val.length < min) {
    return { name, ok: false, severity: "warn", detail: `only ${val.length} chars; use ≥${min} for a guess-resistant token` };
  }
  return { name, ok: true, severity: "error" };
}

/**
 * Format-validate the runtime env. Catches *misshapen* config — e.g. WEBHOOK_SHARED_SECRET pasted as
 * a full URL instead of the path token — which otherwise 403s every Meltwater delivery with no error.
 * It cannot catch a *well-formed but wrong* value (a token that simply doesn't match Meltwater's) —
 * that failure mode is covered by the ingestion heartbeat, not here. Returns names + reasons only,
 * never secret values, so the result is safe to expose.
 */
export function validateConfig(env: Env): ConfigCheck[] {
  const checks: ConfigCheck[] = [
    tokenCheck("WEBHOOK_SHARED_SECRET", env.WEBHOOK_SHARED_SECRET),
    tokenCheck("REPLAY_KEY", env.REPLAY_KEY),
  ];

  // Slack bot token: xoxb-… (a webhook URL or user/app token won't authorize chat.postMessage).
  const bot = env.SLACK_BOT_TOKEN;
  checks.push({
    name: "SLACK_BOT_TOKEN",
    ok: !!bot && bot.startsWith("xoxb-") && bot.length > 20,
    severity: "error",
    detail: !bot ? "missing" : !bot.startsWith("xoxb-") ? "should be a bot token starting with 'xoxb-'" : bot.length <= 20 ? "implausibly short for a bot token" : undefined,
  });

  // Slack channel: an id (C/G/D…) or a #name. A bare name without '#' won't resolve.
  const ch = env.SLACK_DEFAULT_CHANNEL;
  checks.push({
    name: "SLACK_DEFAULT_CHANNEL",
    ok: !!ch && /^([CGD][A-Z0-9]{6,}|#[\w-]+)$/.test(ch),
    severity: "error",
    detail: ch ? "expected a channel id (e.g. C0123ABCD) or #channel-name" : "missing",
  });

  // POSTING_ENABLED gate is a strict `=== "true"`, so anything else silently pauses posting.
  const pe = env.POSTING_ENABLED;
  checks.push({
    name: "POSTING_ENABLED",
    ok: pe === "true" || pe === "false",
    severity: "warn",
    detail: pe === "true" || pe === "false" ? undefined : `is ${JSON.stringify(pe)}; only the exact string "true" enables posting`,
  });

  return checks;
}

/** Roll checks into a public-safe summary: `ok` is false iff any error-severity check failed. */
export function summarizeConfig(checks: ConfigCheck[]): {
  ok: boolean;
  issues: { name: string; severity: "error" | "warn"; detail?: string }[];
} {
  const issues = checks.filter((c) => !c.ok).map(({ name, severity, detail }) => ({ name, severity, detail }));
  return { ok: !issues.some((i) => i.severity === "error"), issues };
}
