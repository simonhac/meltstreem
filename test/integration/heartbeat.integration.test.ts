import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runHeartbeat, LAST_ALERT_KEY } from "@/lib/heartbeat";
import { OpsState } from "@/lib/store/opsState";

const H = 60 * 60 * 1000;
const NOW = 1_783_600_000_000;

// Insert a bare webhook_events row with a chosen receipt time (only received_at matters here).
async function logEventAt(receivedAt: number, id = `hb-${receivedAt}`) {
  await env.DB.prepare(
    `INSERT INTO webhook_events (id, received_at, raw_json, decision, posted) VALUES (?, ?, '{}', 'logged', 0)`,
  )
    .bind(id, receivedAt)
    .run();
}

describe("runHeartbeat (real D1 + mocked Slack)", () => {
  let calls: { url: string; body: any }[];

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM webhook_events").run();
    await env.DB.prepare("DELETE FROM ops_state").run();
    calls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
        return Response.json({ ok: true, ts: "1783500000.000200" });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  const posted = () => calls.filter((c) => c.url.includes("chat.postMessage"));

  it("stays quiet when the feed is fresh", async () => {
    await logEventAt(NOW - 1 * H);
    const r = await runHeartbeat(env, NOW);
    expect(r.healthy).toBe(true);
    expect(r.alerted).toBe(false);
    expect(posted()).toHaveLength(0);
  });

  it("alerts once on a stall and records the marker, then suppresses within the window", async () => {
    await logEventAt(NOW - 5 * H); // 5h > 3h default threshold

    const first = await runHeartbeat(env, NOW);
    expect(first.alerted).toBe(true);
    expect(posted()).toHaveLength(1);
    expect(posted()[0]!.body.channel).toBe("C_TEST");
    expect(posted()[0]!.body.text).toMatch(/ingestion stalled/i);
    expect(await new OpsState(env.DB).getNumber(LAST_ALERT_KEY)).toBe(NOW);

    // Same stall an hour later — inside the 6h re-alert window → no second page.
    const second = await runHeartbeat(env, NOW + 1 * H);
    expect(second.alerted).toBe(false);
    expect(second.suppressed).toBe(true);
    expect(posted()).toHaveLength(1);
  });

  it("re-alerts once the re-alert window elapses", async () => {
    await logEventAt(NOW - 5 * H);
    await runHeartbeat(env, NOW); // sets marker at NOW
    calls = [];
    const later = await runHeartbeat(env, NOW + 7 * H); // marker now 7h old > 6h window
    expect(later.alerted).toBe(true);
    expect(posted()).toHaveLength(1);
  });

  it("clears the marker once ingestion recovers, so the next stall alerts immediately", async () => {
    await logEventAt(NOW - 5 * H);
    await runHeartbeat(env, NOW); // alert + marker set
    expect(await new OpsState(env.DB).getNumber(LAST_ALERT_KEY)).toBe(NOW);

    // A fresh event arrives → healthy → marker cleared.
    await logEventAt(NOW + 1 * H);
    const healthy = await runHeartbeat(env, NOW + 1 * H);
    expect(healthy.healthy).toBe(true);
    expect(await new OpsState(env.DB).getNumber(LAST_ALERT_KEY)).toBeNull();
  });

  it("alerts when no events have ever been recorded", async () => {
    const r = await runHeartbeat(env, NOW);
    expect(r.alerted).toBe(true);
    expect(r.ageHours).toBeNull();
    expect(posted()[0]!.body.text).toMatch(/no events on record/i);
  });
});
