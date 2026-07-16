import { DurableObject } from "cloudflare:workers";
import puppeteer from "@cloudflare/puppeteer";
import type { Env } from "@/env";
import { renderTitleOnPage, stationNameFromTitle } from "@/lib/meltwater/station-resolve";
import { stationNameForCode, upsertStationName } from "@/lib/meltwater/stations";

// --- free-tier Browser Rendering guards (see README / plan) ---
/** At most one NEW browser instance per 20s on the free plan. We reuse one browser per drain, so
 * this only spaces consecutive drains that each have to launch fresh. */
const MIN_LAUNCH_SPACING_MS = 20_000;
/** 10 min/day browser time on the free plan — stop a margin under it and resume the next UTC day. */
const DAILY_BUDGET_MS = 9 * 60 * 1000;
/** Give up on a code after this many failed render attempts (a permanently-broken viewer). */
const MAX_ATTEMPTS = 5;
/** Codes rendered per drain pass, so one alarm invocation stays well within Worker limits. */
const PER_DRAIN_MAX = 25;
/** When work remains after a pass, re-arm the alarm this far out (also covers launch spacing). */
const RESUME_DELAY_MS = 20_000;
const DAY_MS = 86_400_000;

interface QueueRow {
  code: string;
  viewer_url: string;
  attempts: number;
}

interface Budget {
  day: number;
  usedMs: number;
}

/**
 * Serial broadcast-station renderer — the ONLY place a browser is launched. A single account-wide
 * instance (see {@link client}) is single-threaded, so bursts of ingest enqueues collapse into ONE
 * warm, serial drain instead of dozens of concurrent `puppeteer.launch()` calls that the free tier's
 * "1 new browser / 20s" limit would reject (→ 0% success in production before this). The queue lives
 * in D1 (`render_queue`, deduped by code); coordination state (last launch, daily budget) lives in DO
 * storage. Ingestion posts the safety-net card immediately and this fills in the real station later,
 * which the hourly redecode then upgrades onto the posted card.
 */
export class StationRenderer extends DurableObject<Env> {
  /** In-isolate reentrancy guard for {@link drain} (alarms never overlap, but this is belt-and-braces). */
  private draining = false;

  /** Queue a code for rendering (idempotent) and ensure the drainer will run. */
  async enqueue(code: string, viewerUrl: string): Promise<void> {
    await this.env.DB.prepare(
      "INSERT OR IGNORE INTO render_queue (code, viewer_url, attempts, enqueued_at) VALUES (?, ?, 0, ?)",
    )
      .bind(code, viewerUrl, Date.now())
      .run();
    await this.ensureAlarm(Date.now());
  }

  /** Kick the drainer to service any backlog (cron backstop) — only arms when there's real work, so a
   * poke with an empty queue does nothing (no stray alarm). */
  async poke(): Promise<void> {
    if ((await this.pending()) > 0) await this.ensureAlarm(Date.now());
  }

  /** Arm the alarm for `at` (never sooner than launch spacing) unless one is already pending. */
  private async ensureAlarm(at: number): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) != null) return;
    const lastLaunch = (await this.ctx.storage.get<number>("lastLaunchAt")) ?? 0;
    await this.ctx.storage.setAlarm(Math.max(at, lastLaunch + MIN_LAUNCH_SPACING_MS));
  }

  async alarm(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    let next: number | null = null;
    try {
      next = await this.drain(); // epoch ms to resume, or null to go idle
    } catch (e) {
      console.error(`[station-render] drain failed: ${String(e)}`);
      next = Date.now() + RESUME_DELAY_MS;
    } finally {
      this.draining = false;
    }
    if (next != null) await this.ensureAlarm(next);
  }

  private async pending(): Promise<number> {
    const row = await this.env.DB.prepare("SELECT COUNT(*) AS n FROM render_queue WHERE attempts < ?")
      .bind(MAX_ATTEMPTS)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  /**
   * One drain pass: reuse a single browser across every queued code, then disconnect. Returns the
   * epoch ms at which to run the NEXT pass, or null when there's nothing more to do (empty queue, or
   * no Browser Rendering binding — so we never busy-loop re-arming when we can't make progress).
   */
  private async drain(): Promise<number | null> {
    if (!this.env.BROWSER) return null; // no binding (tests) → idle, don't re-arm
    if ((await this.budgetRemainingMs()) <= 0) return nextUtcDay(); // out of daily browser time

    const items = (
      await this.env.DB.prepare(
        "SELECT code, viewer_url, attempts FROM render_queue WHERE attempts < ? ORDER BY enqueued_at LIMIT ?",
      )
        .bind(MAX_ATTEMPTS, PER_DRAIN_MAX)
        .all<QueueRow>()
    ).results;
    if (!items.length) return null;

    const browser = await this.acquireBrowser();
    if (!browser) return Date.now() + RESUME_DELAY_MS; // launch spacing not met → retry soon

    const start = Date.now();
    try {
      const page = await browser.newPage();
      for (const it of items) {
        if ((await this.budgetRemainingMs()) <= 0) break;
        // A station-labelled sibling (authorName-trust) may have named this code since it was queued.
        if (await stationNameForCode(this.env.DB, it.code)) {
          await this.del(it.code);
          continue;
        }
        const title = await renderTitleOnPage(page, it.viewer_url).catch(() => null);
        const name = stationNameFromTitle(title);
        if (name) {
          await upsertStationName(this.env.DB, it.code, name, Date.now(), it.attempts + 1); // count this attempt
          await this.del(it.code);
        } else {
          await this.bump(it.code);
        }
      }
      await page.close().catch(() => {});
    } finally {
      await browser.disconnect().catch(() => {}); // keep the session warm for the next drain, don't close
      await this.addBudget(Date.now() - start);
    }

    if ((await this.pending()) === 0) return null; // queue drained → go idle
    if ((await this.budgetRemainingMs()) <= 0) return nextUtcDay(); // spent the budget → resume tomorrow
    return Date.now() + RESUME_DELAY_MS; // more codes remain → come back soon
  }

  /** Reuse a warm session if one is free (no new-instance cost), else launch — but only when it's
   * been ≥20s since the last launch, otherwise defer to the next alarm. */
  private async acquireBrowser() {
    const br = this.env.BROWSER!;
    try {
      const sessions = await puppeteer.sessions(br);
      const free = sessions.find((s) => !s.connectionId);
      if (free) return await puppeteer.connect(br, free.sessionId);
    } catch {
      /* no reusable session → fall through to a fresh launch */
    }
    const lastLaunch = (await this.ctx.storage.get<number>("lastLaunchAt")) ?? 0;
    if (Date.now() < lastLaunch + MIN_LAUNCH_SPACING_MS) return null; // respect 1-new-browser/20s
    try {
      const browser = await puppeteer.launch(br);
      await this.ctx.storage.put("lastLaunchAt", Date.now());
      return browser;
    } catch {
      return null;
    }
  }

  private async del(code: string): Promise<void> {
    await this.env.DB.prepare("DELETE FROM render_queue WHERE code = ?").bind(code).run();
  }

  private async bump(code: string): Promise<void> {
    await this.env.DB.prepare(
      "UPDATE render_queue SET attempts = attempts + 1, last_attempt_at = ? WHERE code = ?",
    )
      .bind(Date.now(), code)
      .run();
  }

  // --- daily browser-time budget, reset per UTC day ---
  private async budgetRemainingMs(): Promise<number> {
    const day = Math.floor(Date.now() / DAY_MS);
    const b = (await this.ctx.storage.get<Budget>("budget")) ?? { day, usedMs: 0 };
    const usedMs = b.day === day ? b.usedMs : 0;
    return DAILY_BUDGET_MS - usedMs;
  }

  private async addBudget(ms: number): Promise<void> {
    const day = Math.floor(Date.now() / DAY_MS);
    const b = (await this.ctx.storage.get<Budget>("budget")) ?? { day, usedMs: 0 };
    const usedMs = (b.day === day ? b.usedMs : 0) + Math.max(0, ms);
    await this.ctx.storage.put("budget", { day, usedMs });
  }
}

/** Epoch ms at the start of the next UTC day — when the daily browser-time budget resets. */
function nextUtcDay(): number {
  return (Math.floor(Date.now() / DAY_MS) + 1) * DAY_MS;
}
