import { describe, it, expect } from "vitest";
import { decideHeartbeat } from "@/lib/heartbeat";

const H = 60 * 60 * 1000;
const NOW = 1_783_600_000_000;
// Defaults mirror runHeartbeat: 3h silence threshold, 6h re-alert window.
const base = { now: NOW, thresholdHours: 3, reAlertHours: 6, lastAlertAt: null as number | null };

describe("decideHeartbeat", () => {
  it("fresh ingestion is healthy and does not alert", () => {
    const d = decideHeartbeat({ ...base, latest: NOW - 1 * H });
    expect(d).toMatchObject({ healthy: true, shouldAlert: false, suppressed: false });
    expect(d.ageHours).toBeCloseTo(1);
  });

  it("age exactly at the threshold is still healthy (<=)", () => {
    expect(decideHeartbeat({ ...base, latest: NOW - 3 * H }).healthy).toBe(true);
  });

  it("a stall past the threshold with no prior alert fires an alert", () => {
    const d = decideHeartbeat({ ...base, latest: NOW - 5 * H });
    expect(d).toMatchObject({ healthy: false, shouldAlert: true, suppressed: false });
    expect(d.ageHours).toBeCloseTo(5);
  });

  it("a stall is suppressed while a prior alert is inside the re-alert window", () => {
    const d = decideHeartbeat({ ...base, latest: NOW - 5 * H, lastAlertAt: NOW - 1 * H });
    expect(d).toMatchObject({ healthy: false, shouldAlert: false, suppressed: true });
  });

  it("a stall re-alerts once the re-alert window has elapsed", () => {
    const d = decideHeartbeat({ ...base, latest: NOW - 12 * H, lastAlertAt: NOW - 7 * H });
    expect(d).toMatchObject({ healthy: false, shouldAlert: true, suppressed: false });
  });

  it("no events ever recorded counts as a stall (age null) and alerts", () => {
    const d = decideHeartbeat({ ...base, latest: null });
    expect(d).toMatchObject({ healthy: false, ageHours: null, shouldAlert: true });
  });

  it("no events ever, but within a prior alert window → suppressed", () => {
    const d = decideHeartbeat({ ...base, latest: null, lastAlertAt: NOW - 1 * H });
    expect(d).toMatchObject({ healthy: false, ageHours: null, shouldAlert: false, suppressed: true });
  });
});
