import { MEDIA_ICON_PNG } from "@/assets/mediaIcons";

/** Small square icon for any domain (Google's favicon service — returns a globe for unknown
 * domains, so it never 404s a broken image; safe as a universal logo fallback). */
function googleFavicon(domain: string): string {
  return `https://www.google.com/s2/favicons?sz=64&domain=${domain}`;
}

/**
 * Per-outlet logos, keyed by a lowercase substring of the source name. The outlet's real
 * domain is turned into a favicon so the on-air brand shows even when the article URL is a
 * clip/aggregator link (common for broadcast). Extend freely — most specific names first.
 */
const SOURCE_LOGOS: Record<string, string> = {
  "the australian": googleFavicon("theaustralian.com.au"),
  "sky news": googleFavicon("skynews.com.au"),
  "renew economy": googleFavicon("reneweconomy.com.au"),
  "the guardian": googleFavicon("theguardian.com"),
  abc: googleFavicon("abc.net.au"),
};

/** Favicon derived from the article URL's own domain — the default when a source isn't mapped. */
export function faviconUrl(pageUrl: string | null): string | null {
  if (!pageUrl) return null;
  try {
    const host = new URL(pageUrl).hostname.replace(/^www\./, "");
    return host ? googleFavicon(host) : null;
  } catch {
    return null;
  }
}

/** Best logo image URL for a mention's outlet: curated map first, then the article's own domain. */
export function sourceLogoUrl(sourceName: string | null, pageUrl: string | null): string | null {
  if (sourceName) {
    const key = sourceName.toLowerCase();
    for (const [name, url] of Object.entries(SOURCE_LOGOS)) {
      if (key.includes(name)) return url;
    }
  }
  return faviconUrl(pageUrl);
}

// Checked in order; "online" must precede "news"/"print" so "online_news" resolves to 🌐.
const MEDIA_EMOJI: Array<[string, string]> = [
  ["radio", "📻"],
  ["television", "📺"],
  ["tv", "📺"],
  ["online", "🌐"],
  ["web", "🌐"],
  ["social", "💬"],
  ["blog", "💬"],
  ["print", "📰"],
  ["news", "📰"],
];

/** Fallback glyph for the outlet line when there's no logo image (no URL and not in the map). */
export function mediaTypeEmoji(mediaType: string | null): string {
  if (mediaType) {
    const k = mediaType.toLowerCase();
    for (const [t, e] of MEDIA_EMOJI) if (k.includes(t)) return e;
  }
  return "📰";
}

/** Public origin the Worker is reachable at — footer_icon URLs must be absolute and fetchable by
 * Slack's image proxy. A constant (not env) so `attachmentHash` stays stable across renders. */
export const ICON_BASE_URL = "https://feed.moofer.com";

// Media type → Lucide icon slug. Same match order/precedence as MEDIA_EMOJI ("online" before
// "news"/"print"). Each slug is a Lucide icon name served as a PNG at /icons/media/v1/<slug>.png.
const MEDIA_ICON: Array<[string, string]> = [
  ["radio", "radio"],
  ["television", "tv"],
  ["tv", "tv"],
  ["online", "globe"],
  ["web", "globe"],
  ["social", "message-circle"],
  ["blog", "message-circle"],
  ["print", "newspaper"],
  ["news", "newspaper"],
];

/** Lucide icon slug for a media type; falls back to "newspaper". Keep in sync with the SLUGS list
 * in scripts/gen-media-icons.mjs. */
export function mediaTypeIconSlug(mediaType: string | null): string {
  if (mediaType) {
    const k = mediaType.toLowerCase();
    for (const [t, s] of MEDIA_ICON) if (k.includes(t)) return s;
  }
  return "newspaper";
}

/** Short FNV-1a of a string → 8 hex chars. Used as a content cache-buster on the icon URLs. */
function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Absolute URL for a media type's footer icon PNG (Slack attachment `footer_icon`). A `?v=<hash>`
 * of the PNG bytes busts Slack's image proxy (which caches by URL, immutably) whenever we regenerate
 * the icons — e.g. after tuning the vertical lift — without hand-bumping a version segment.
 */
export function mediaTypeIconUrl(mediaType: string | null): string {
  const slug = mediaTypeIconSlug(mediaType);
  return `${ICON_BASE_URL}/icons/media/v1/${slug}.png?v=${shortHash(MEDIA_ICON_PNG[slug] ?? slug)}`;
}
