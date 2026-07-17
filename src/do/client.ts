import type { Env } from "@/env";
import type { RenderState } from "@/do/stationRenderer";

// One account-wide StationRenderer instance — a fixed name so every enqueue/poke hits the same
// single-threaded object (the serialization guarantee that keeps us under the free-tier limits).
const SINGLETON = "station-renderer";

function stub(env: Env) {
  return env.STATION_RENDERER!.get(env.STATION_RENDERER!.idFromName(SINGLETON));
}

/** Live drainer state for the status page (budget, last launch, next alarm, queue depth). Null
 * without the binding or on any RPC error. */
export async function getRenderState(env: Env): Promise<RenderState | null> {
  if (!env.STATION_RENDERER) return null;
  try {
    return await stub(env).state();
  } catch (e) {
    console.error(`[station-render] state failed: ${String(e)}`);
    return null;
  }
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

/**
 * Best-effort SYNCHRONOUS station-name resolve for the ingestion path, capped at `deadlineMs` so a
 * slow/broken viewer can't stall the queue consumer. Returns the resolved name, or `null` on
 * timeout / error / missing binding / a deferred render (spacing, budget, backoff) — the caller then
 * falls back to the neutral masthead + deferred enqueue. When the deadline wins, the DO's `resolveNow`
 * keeps running server-side and may still name the code for next time. Mirrors the no-throw contract
 * of {@link enqueueStationRender}.
 */
export async function resolveStationNow(
  env: Env,
  code: string,
  viewerUrl: string,
  deadlineMs: number,
): Promise<string | null> {
  if (!env.STATION_RENDERER) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const rpc = stub(env)
      .resolveNow(code, viewerUrl)
      .catch((e) => {
        console.error(`[station-render] resolveNow failed for ${code}: ${String(e)}`);
        return null;
      });
    const timed = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), deadlineMs);
    });
    return (await Promise.race([rpc, timed])) ?? null;
  } finally {
    if (timer) clearTimeout(timer);
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
