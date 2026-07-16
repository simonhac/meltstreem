import type { Env } from "@/env";

// One account-wide StationRenderer instance — a fixed name so every enqueue/poke hits the same
// single-threaded object (the serialization guarantee that keeps us under the free-tier limits).
const SINGLETON = "station-renderer";

function stub(env: Env) {
  return env.STATION_RENDERER!.get(env.STATION_RENDERER!.idFromName(SINGLETON));
}

/** Queue a broadcast code for background rendering and kick the drainer. No-op without the binding
 * (unit tests) or on any RPC error — resolution just falls back to the safety-net card. */
export async function enqueueStationRender(env: Env, code: string, viewerUrl: string): Promise<void> {
  if (!env.STATION_RENDERER) return;
  try {
    await stub(env).enqueue(code, viewerUrl);
  } catch (e) {
    console.error(`[station-render] enqueue failed for ${code}: ${String(e)}`);
  }
}

/** Kick the drainer to service any backlog (cron backstop). No-op without the binding / on error. */
export async function pokeStationRender(env: Env): Promise<void> {
  if (!env.STATION_RENDERER) return;
  try {
    await stub(env).poke();
  } catch (e) {
    console.error(`[station-render] poke failed: ${String(e)}`);
  }
}
