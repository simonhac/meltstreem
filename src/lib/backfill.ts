import type { Env } from "@/env";
import { parseWebhookPayload, isBroadcastMedium } from "@/lib/meltwater/parse";
import { stationCodeFor, viewerUrlForRaw } from "@/lib/meltwater/station-resolve";
import { stationNameForCode, upsertStationName } from "@/lib/meltwater/stations";
import { looksLikePerson } from "@/lib/meltwater/outlets";
import { enqueueStationRender } from "@/do/client";

export interface BackfillResult {
  events: number; // archived events scanned
  broadcast: number; // broadcast mentions seen
  known: number; // codes already named (nothing to do)
  seeded: number; // codes named from a station-like authorName (render-free)
  enqueued: number; // codes queued for the serial renderer (presenter authorName, unknown station)
  noCode: number; // broadcast mentions whose code couldn't be extracted
}

/**
 * One-time warm start: re-scan the archived webhooks and, for every broadcast mention with a
 * resolvable station code that isn't named yet, either seed `station_names` from a station-like
 * `authorName` (render-free) or enqueue it for the StationRenderer DO. This front-loads the D1 map so
 * most stations are named up front; the hourly redecode then upgrades their already-posted cards.
 * Idempotent and re-runnable (dedupe is by code); returns counts. Newest-first, capped by `limit`.
 */
export async function backfillStations(env: Env, opts: { limit: number }): Promise<BackfillResult> {
  const res: BackfillResult = { events: 0, broadcast: 0, known: 0, seeded: 0, enqueued: 0, noCode: 0 };
  const now = Date.now();

  // Reconstruct each code's first-sighting from the cache, so a render-free authorName name is stamped
  // with WHEN it was first resolvable (not "now") — a faithful historical resolution time on /stations.
  const firstSeen = new Map<string, number>();
  for (const r of (
    await env.DB.prepare("SELECT code, MIN(resolved_at) AS fs FROM broadcast_stations WHERE code IS NOT NULL GROUP BY code")
      .all<{ code: string; fs: number }>()
  ).results) {
    firstSeen.set(r.code, r.fs);
  }

  const rows = (
    await env.DB.prepare(
      "SELECT raw_json FROM webhook_events WHERE json_valid(raw_json) ORDER BY received_at DESC LIMIT ?",
    )
      .bind(opts.limit)
      .all<{ raw_json: string }>()
  ).results;

  const seededThisRun = new Set<string>(); // avoid re-hitting D1/DO for a code already handled here

  for (const row of rows) {
    res.events++;
    let payload: unknown;
    try {
      payload = JSON.parse(row.raw_json);
    } catch {
      continue;
    }
    for (const m of parseWebhookPayload(payload)) {
      if (!isBroadcastMedium(m.mediaType)) continue;
      res.broadcast++;
      const code = (await stationCodeFor(env, m.raw))?.code ?? null;
      if (!code) {
        res.noCode++;
        continue;
      }
      if (seededThisRun.has(code)) continue;
      if (await stationNameForCode(env.DB, code)) {
        res.known++;
        seededThisRun.add(code);
        continue;
      }
      const header = m.sourceName?.trim() || null;
      if (header && !looksLikePerson(header)) {
        await upsertStationName(env.DB, code, header, firstSeen.get(code) ?? now, 0); // resolvable since first seen; 0 renders
        res.seeded++;
        seededThisRun.add(code);
        continue;
      }
      const url = viewerUrlForRaw(m.raw);
      if (url) {
        await enqueueStationRender(env, code, url);
        res.enqueued++;
        seededThisRun.add(code);
      }
    }
  }
  return res;
}
