import type { Env } from "@/env";
import puppeteer from "@cloudflare/puppeteer";
import { stationNameForCode, upsertStationName } from "./stations";

type Links = { article?: unknown; source?: unknown } | null | undefined;

/** Unwrap a Meltwater click-tracking URL to its underlying `u=` target. */
function unwrapU(t: unknown): string | null {
  if (typeof t !== "string") return null;
  try {
    const u = new URL(t).searchParams.get("u");
    return u ? decodeURIComponent(u) : t;
  } catch {
    return null;
  }
}

/** The best link to follow to the broadcast viewer (article first, then source), unwrapped. */
function viewerUrl(links: Links): string | null {
  return unwrapU(links?.article) ?? unwrapU(links?.source);
}

/** Meltwater document id from a `.../paywall/redirect/<docId>` transition link. */
export function docIdFromLinks(links: unknown): string | null {
  const l = links as Links;
  const art = unwrapU(l?.article) ?? unwrapU(l?.source);
  const m = art?.match(/\/paywall\/redirect\/([^/?]+)/);
  return m ? m[1]! : null;
}

/** Fetch the transition link and read `Station=<code>` from the mediaView redirect it serves. */
async function fetchStationCode(transitionUrl: string): Promise<string | null> {
  try {
    const res = await fetch(transitionUrl, { signal: AbortSignal.timeout(8000) });
    const html = await res.text();
    const m = html.match(/https:\/\/broadcast\.meltwater\.com\/mediaView\/\?[A-Za-z0-9%._-]+/);
    if (!m) return null;
    const token = new URL(m[0]).search.replace(/^\?/, "").split("&")[0]!;
    const decoded = atob(decodeURIComponent(token)); // Station=<code>&StartDateTime=...
    return decoded.match(/Station=([^&]+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Resolve the Meltwater numeric broadcast code for an item (cached in D1 by docId; fetched on miss). */
async function stationCodeFor(env: Env, raw: unknown): Promise<{ docId: string; code: string | null } | null> {
  const links = (raw as { links?: unknown } | null)?.links as Links;
  const docId = docIdFromLinks(links);
  if (!docId) return null;

  const cached = await env.DB.prepare("SELECT code FROM broadcast_stations WHERE doc_id = ?")
    .bind(docId)
    .first<{ code: string | null }>();
  if (cached) return { docId, code: cached.code };

  const transition = viewerUrl(links);
  const code = transition ? await fetchStationCode(transition) : null;
  await env.DB.prepare("INSERT OR REPLACE INTO broadcast_stations (doc_id, code, resolved_at) VALUES (?, ?, ?)")
    .bind(docId, code, Date.now())
    .run();
  return { docId, code };
}

/**
 * Station name from the D1 `station_names` map only (no browser) — the numeric code is cached in D1 by
 * docId, so this is cheap and safe to call from the redecode backfill. Returns null for an unknown code.
 */
export async function resolveStationName(env: Env, raw: unknown): Promise<string | null> {
  const c = await stationCodeFor(env, raw);
  return c ? stationNameForCode(env.DB, c.code) : null;
}

/**
 * Ingestion-time resolution: the D1 map first; on a miss (a station we've never named) render the JS
 * viewer with a fresh token to discover the name and cache it by code — so every later item of that
 * station resolves for free, without a browser.
 */
export async function resolveStationNameLive(env: Env, raw: unknown, now: number): Promise<string | null> {
  const c = await stationCodeFor(env, raw);
  if (!c) return null;
  const known = await stationNameForCode(env.DB, c.code);
  if (known) return known;
  if (!c.code) return null; // no code to key a discovered name on

  const name = await renderStationName(env, raw);
  if (name) await upsertStationName(env.DB, c.code, name, now);
  return name;
}

/**
 * Render the Meltwater broadcast viewer (a client-rendered SPA that curl can't read) via Cloudflare
 * Browser Rendering and read the station name from the page title — "702 ABC Sydney - <program> -
 * <time>" → "702 ABC Sydney". Best-effort: returns null on any failure or an expired token.
 */
export async function renderStationName(env: Env, raw: unknown): Promise<string | null> {
  const target = viewerUrl((raw as { links?: unknown } | null)?.links as Links);
  if (!target) return null;
  const title = await renderViewerTitle(env, target);
  const name = title?.split(" - ")[0]?.trim() ?? "";
  return name && name !== "Broadcast player" ? name : null;
}

/**
 * Load a URL in Cloudflare Browser Rendering and return its final page title. The Meltwater viewer is
 * a client-rendered SPA that redirects transition → mediaView → segment and only then sets a
 * "<Station> - <program> - <time>" title, so we poll until it settles. Best-effort; null on failure or
 * a missing binding. Exported for the /admin/render-station verify endpoint.
 */
export async function renderViewerTitle(env: Env, url: string): Promise<string | null> {
  if (!env.BROWSER) return null; // no Browser Rendering binding (e.g. tests) → skip
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
  try {
    browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    let title = "";
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 1200));
      title = (await page.title().catch(() => "")) || "";
      if (title && title !== "Broadcast player" && title.includes(" - ")) break;
    }
    return title || null;
  } catch {
    return null;
  } finally {
    if (browser) await browser.disconnect().catch(() => {});
  }
}
