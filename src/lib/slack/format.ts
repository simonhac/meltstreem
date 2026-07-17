import type { NormalizedMention } from "@/lib/meltwater/types";
import { directArticleUrl } from "@/lib/meltwater/parse";
import type { Outlet } from "@/lib/story";
import { type BriefRule, DEFAULT_BRIEF_COLOR } from "@/config/feed.config";
import { keywordsFor } from "@/lib/filter/engine";
import { sourceLogoUrl, mediaTypeIconUrl } from "./icons";
import {
  escapeMrkdwn,
  highlightKeywordsAsCode,
  buildMentionsLine,
  hasAnyKeyword,
} from "./highlight";

/**
 * A Streem-style card, built as a CLASSIC (legacy-field) Slack attachment — not blocks-in-attachment.
 * Classic fields map 1:1 onto Streem's layout: author_icon+author_name = logo+masthead (with the
 * byline appended), title+title_link = the headline link, text = the excerpt (with keyword pills),
 * footer = the meta line (media icon + date · Brief(s) + sentiment · reach), footer_icon = the
 * Lucide media-type glyph, color = the left bar.
 */
export interface SlackAttachment {
  color: string;
  /** Notification / no-attachment-support fallback (replaces the top-level `text`). */
  fallback: string;
  author_name?: string;
  author_icon?: string;
  /** Hyperlinks the author_name (the masthead) — set only when the title just repeats the masthead. */
  author_link?: string;
  title?: string;
  title_link?: string;
  text?: string;
  footer?: string;
  /** Small (16px) icon rendered at the start of the footer — the media-type Lucide PNG. */
  footer_icon?: string;
  mrkdwn_in: string[];
}

export interface SlackPostPayload {
  channel: string;
  // No top-level `text` — it renders a plain line above the card (the attachment `fallback` covers notifications).
  attachments: SlackAttachment[];
  unfurl_links: false;
  unfurl_media: false;
}

/** The trailing "go direct" glyph: U+2197 (↗) + U+FE0E text-presentation selector. The selector
 * stops Slack rendering it as the chunky `:arrow_upper_right:` emoji — it stays a demure text arrow
 * (blue, since it's a link label). Kept as explicit escapes so the invisible selector is visible in
 * source. Exported so tests assert against the exact glyph. */
export const OFFSITE_ARROW = "\u2197\uFE0E";

const DATE_PARTS = { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true } as const;
// Render the wall-clock time in the source's own offset (read UTC parts off a shifted date).
const UTC_FMT = new Intl.DateTimeFormat("en-AU", { ...DATE_PARTS, timeZone: "UTC" });
// Fallback only for timestamps that carry no offset — display in the feed's home timezone.
const HOME_FMT = new Intl.DateTimeFormat("en-AU", { ...DATE_PARTS, timeZone: "Australia/Sydney", timeZoneName: "short" });

// UTC offset (minutes) → Australian abbreviation; anything else falls back to a "UTC±H" label.
const OFFSET_ABBR: Record<number, string> = { 0: "UTC", 480: "AWST", 525: "ACWST", 570: "ACST", 600: "AEST", 630: "ACDT", 660: "AEDT" };

function offsetAbbrev(offMin: number): string {
  if (OFFSET_ABBR[offMin]) return OFFSET_ABBR[offMin]!;
  const a = Math.abs(offMin);
  const mm = a % 60;
  return `UTC${offMin < 0 ? "-" : "+"}${Math.floor(a / 60)}${mm ? ":" + String(mm).padStart(2, "0") : ""}`;
}

/** Minutes east of UTC parsed from a trailing "+10:00" / "+1000" / "Z"; null if none present. */
function parseOffsetMinutes(input: string): number | null {
  const s = input.trim();
  if (/[zZ]$/.test(s)) return 0;
  const m = /([+-])(\d{2}):?(\d{2})$/.exec(s);
  if (!m) return null;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

// `timePrefix` marks an approximate time (a "~" for the webhook-receipt fallback); "" otherwise.
function assemble(p: Record<string, string>, abbr: string, timePrefix = ""): string {
  const period = (p.dayPeriod ?? "").toLowerCase().replace(/\s/g, "");
  // en-AU renders some short months in full (e.g. "July"); slice normalises every month to 3 letters.
  const month = (p.month ?? "").slice(0, 3);
  return `${p.weekday}, ${p.day} ${month} ${p.year}, ${timePrefix}${p.hour}:${p.minute}${period} ${abbr}`;
}

function partsOf(fmt: Intl.DateTimeFormat, d: Date): Record<string, string> {
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(d)) p[part.type] = part.value;
  return p;
}

/**
 * Format an ISO/RFC date as e.g. "Wed, 8 Jul 2026, 8:30am AEST" — using the timestamp's OWN
 * offset for both the time and the abbreviation (+08:00 → AWST, +11:00 → AEDT, …). Null if
 * unparseable. Timestamps without an offset fall back to the feed's home timezone.
 */
export function fmtFriendly(input: string | null): string | null {
  if (!input) return null;
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  const offMin = parseOffsetMinutes(input);
  if (offMin === null) {
    const p = partsOf(HOME_FMT, d);
    return assemble(p, p.timeZoneName ?? "");
  }
  const shifted = new Date(d.getTime() + offMin * 60_000);
  return assemble(partsOf(UTC_FMT, shifted), offsetAbbrev(offMin));
}

/**
 * Last-resort date for the footer: the webhook-receipt instant (epoch ms) rendered in the feed's
 * home timezone and marked approximate with a "~" before the time — e.g. "Wed, 8 Jul 2026, ~7:40am
 * AEST". Used only when the payload carries no publish date (Meltwater's "Every Mention" shape omits
 * it) and the title has no broadcast air-time; the "~" flags that this is the receipt time, not the
 * story's own timestamp. Null for a missing/invalid instant.
 */
export function fmtReceivedApprox(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms)) return null;
  const p = partsOf(HOME_FMT, new Date(ms));
  return assemble(p, p.timeZoneName ?? "", "~");
}

/** Compact number, e.g. 480000 → "480K", 2500000 → "2.5M", 5860 → "5.9K" (null when absent/zero). */
export function compactReach(n: number | null): string | null {
  if (n === null || !Number.isFinite(n) || n <= 0) return null;
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(n >= 100_000 ? 0 : 1).replace(/\.0$/, "") + "K";
  return String(n);
}

/** Compact reach with suffix, e.g. 480000 → "480K reach" (null when absent/zero). */
export function fmtReach(n: number | null): string | null {
  const c = compactReach(n);
  return c && `${c} reach`;
}

/** Thumbs marker for a mention's sentiment; null when unknown. */
function sentimentEmoji(sentiment: string | null): string | null {
  switch (sentiment) {
    case "positive": return "👍";
    case "negative": return "👎";
    case "neutral": return "😐";
    default: return null;
  }
}

// Broadcast titles arrive as "<program> - Wed, 08 Jul 2026 08:30:58 +1000"; capture the RFC tail.
const BROADCAST_TAIL = /\s+-\s+(\w{3},\s*\d{1,2}\s+\w{3}\s+\d{4}\s+\d{1,2}:\d{2}(?::\d{2})?\s*[+-]\d{4})\s*$/;

/** The raw air-date tail of a broadcast title ("Wed, 08 Jul 2026 08:30:58 +1000"), or null. */
export function broadcastAirtime(title: string | null): string | null {
  if (!title) return null;
  const m = BROADCAST_TAIL.exec(title);
  return m ? m[1]! : null;
}

/** Strip a broadcast title's trailing air date/time, leaving just the program name (its time moves
 * to the footer). Non-broadcast titles pass through unchanged. */
export function cleanTitle(title: string | null): string | null {
  if (!title) return title;
  const m = BROADCAST_TAIL.exec(title);
  return m ? title.slice(0, m.index).trimEnd() : title;
}

/** Left-bar colour for a brief (its own colour, else the shared default). */
export function briefColor(brief: BriefRule): string {
  return brief.color ?? DEFAULT_BRIEF_COLOR;
}

/**
 * Neutral outlet label for a broadcast item whose station couldn't be resolved — so a presenter's
 * name never sits in the masthead slot. The program/host stays the headline; this is just the
 * medium ("Radio"/"TV").
 */
export function broadcastMediumLabel(mediaType: string | null): string {
  const t = (mediaType ?? "").toLowerCase();
  return t.includes("tv") || t.includes("television") ? "TV" : "Radio";
}

/** Case- and whitespace-insensitive equality — for spotting a title that just repeats the masthead. */
export function sameText(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  return norm(a) === norm(b);
}

/**
 * Build the Streem-style classic attachment for one mention. `otherOutlets` are additional outlets
 * that carried the same (syndicated) story (folded into the footer reach + the masthead count);
 * `otherBriefLabels` are the non-primary Organisation Briefs that also matched it (folded into the
 * footer's consolidated "Brief(s): …" list). `receivedAtMs` is the webhook-receipt instant, used
 * only as an approximate ("~") footer date when the mention has no better timestamp.
 */
export function buildAttachment(
  m: NormalizedMention,
  brief: BriefRule,
  otherOutlets: Outlet[] = [],
  otherBriefLabels: string[] = [],
  receivedAtMs: number | null = null,
): SlackAttachment {
  const kws = keywordsFor(m, brief);
  const masthead = m.sourceName ?? "Unknown source";
  const title = cleanTitle(m.title) ?? m.url ?? "(untitled)";

  // For broadcast the program label IS the station name, so the title just repeats the masthead
  // heading (e.g. "Triple M Gippsland 94.3 & 97.9" twice). When they match, don't print it twice:
  // drop the separate title line and hyperlink the heading itself via `author_link` instead.
  const titleRepeatsMasthead = sameText(title, masthead);

  // body: when there's a snippet, always show it (keywords highlighted as pills) and append an
  // "(also mentions `kw` …)" suffix listing every Meltwater-matched keyword NOT already visible in the
  // title or snippet. Meltwater matches keywords across the whole article but sends only a short (≤300-
  // char) excerpt, so most matched keywords aren't in it — the suffix surfaces them. Snippets arrive
  // pre-trimmed, so no truncation is needed. With no snippet, fall back to the "Mentions: kw (n)" line.
  const fullText = `${m.title ?? ""} ${m.snippet ?? ""}`.trim();
  let text: string | undefined;
  if (m.snippet) {
    const body = highlightKeywordsAsCode(m.snippet, kws); // escapes + pills; plain-escaped when kws empty
    const alsoMentions = [...new Set(m.matchedKeywords.filter(Boolean))].filter(
      (k) => !hasAnyKeyword(fullText, [k]),
    );
    const suffix = alsoMentions.length
      ? ` (also mentions ${alsoMentions.map((k) => "`" + escapeMrkdwn(k) + "`").join(" ")})`
      : "";
    text = body + suffix;
  } else {
    text = buildMentionsLine(fullText, kws) ?? undefined;
  }

  // Optional "go direct" link: the publisher's own article URL, unwrapped from the Meltwater tracking
  // link the title uses — so readers can bypass Meltwater. Only when a distinct direct URL exists
  // (web/online items; broadcast clips usually have none). Rendered as a trailing ↗ in the body,
  // the one region Slack renders mrkdwn links in (footers are plain text).
  const direct = directArticleUrl(m.url);
  if (direct) {
    const arrow = `<${escapeMrkdwn(direct)}|${OFFSITE_ARROW}>`;
    text = text ? `${text} ${arrow}` : arrow;
  }

  // Byline for the header masthead ("… — Leith Forrest"). Skip when the author just repeats the
  // headline or the masthead — a host-named broadcast show (a "Tom Elliott" segment) where the
  // presenter already appears as the title/heading, or an outlet whose byline equals its own name.
  // Kept RAW (not mrkdwn-escaped) to match the masthead: author_name isn't in `mrkdwn_in`, and the
  // /inspect mirror HTML-escapes it itself.
  const byline =
    m.author && !sameText(m.author, title) && !sameText(m.author, masthead) ? ` — ${m.author}` : "";

  // footer: [media icon] date · Brief(s) + sentiment · reach. The media type shows as the footer_icon
  // (a Lucide glyph), not a word. Plain text — Slack attachment footers don't render mrkdwn, so no
  // pills. For a multi-outlet story the single reach is replaced by the outlet count + summed reach,
  // then every outlet listed with its OWN reach, descending.
  let reachBit: string | null;
  if (otherOutlets.length) {
    const all = [{ name: masthead, reach: m.reach }, ...otherOutlets.map((o) => ({ name: o.name, reach: o.reach }))].sort(
      (a, b) => (b.reach ?? -1) - (a.reach ?? -1),
    );
    const count = all.length;
    const total = all
      .map((o) => o.reach)
      .filter((r): r is number => typeof r === "number" && Number.isFinite(r) && r > 0)
      .reduce((a, b) => a + b, 0);
    const combined = compactReach(total);
    const shown = all
      .slice(0, 8)
      .map((o) => {
        const r = compactReach(o.reach)?.toLowerCase(); // per-outlet reach lowercased ("250k"); combined stays "2.6M"
        return r ? `${o.name} (${r})` : o.name;
      })
      .join(" · ");
    const more = all.length > 8 ? ` +${all.length - 8} more` : "";
    reachBit = combined
      ? `${count} outlets with ${combined} combined reach: ${shown}${more}`
      : `${count} outlets: ${shown}${more}`;
  } else {
    reachBit = fmtReach(m.reach);
  }

  // Footer date, best available: the mention's own publish date → a broadcast title's air-time →
  // the webhook-receipt time (marked "~" as an approximate, secondary source).
  const footerDate =
    fmtFriendly(m.publishedAt) ??
    fmtFriendly(broadcastAirtime(m.title)) ??
    fmtReceivedApprox(receivedAtMs);

  // Consolidated Organisation Brief(s), primary first, case-insensitive dedup — the old separate
  // "also matched …" tail folds in here. The sentiment marker rides on this bit ("Brief: Teals 😐").
  const briefs = [brief.label, ...otherBriefLabels].reduce<string[]>((acc, l) => {
    if (!acc.some((x) => x.toLowerCase() === l.toLowerCase())) acc.push(l);
    return acc;
  }, []);
  const sentiment = sentimentEmoji(m.sentiment);
  const briefBit = `${briefs.length > 1 ? "Briefs" : "Brief"}: ${briefs.join(", ")}${sentiment ? ` ${sentiment}` : ""}`;

  const footerBits = [footerDate, briefBit, reachBit].filter((x): x is string => !!x);

  // Masthead: "9 Brisbane + 4 others — Jacob Shteyman" — outlet[ + N others][ — byline]. Keeps the
  // logo (author_icon); classic-attachment author_name is rendered fully bold, so both the "+ N others"
  // count and the byline are bold too (no partial-unbold without leaving the block / dropping the image).
  const headMasthead = `${otherOutlets.length ? `${masthead} + ${otherOutlets.length} others` : masthead}${byline}`;
  const logo = sourceLogoUrl(m.sourceName, m.outletUrl ?? m.url);
  const att: SlackAttachment = {
    color: briefColor(brief),
    fallback: titleRepeatsMasthead ? masthead : `${masthead}: ${title}`,
    author_name: headMasthead,
    // Keep `title` in its original position for the common (non-repeat) case so the attachment hash
    // of every existing card stays stable — only the collapsed broadcast cards should re-render.
    ...(titleRepeatsMasthead ? {} : { title }),
    footer_icon: mediaTypeIconUrl(m.mediaType),
    mrkdwn_in: ["text"],
  };
  if (logo) att.author_icon = logo;
  if (m.url) {
    if (titleRepeatsMasthead) att.author_link = m.url; // link the heading instead of the dropped title
    else att.title_link = m.url;
  }
  if (text) att.text = text;
  if (footerBits.length) att.footer = footerBits.join("  ·  ");
  return att;
}

/** Reconstruct a headline-capable mention from a stored outlet that is taking the lead by reach. Starts
 * from the anchor (so an OLD-shape `{name,url,reach}` outlet cleanly swaps only the masthead + link,
 * keeping the anchor's headline/snippet/byline/keywords), then overrides each display field the outlet
 * actually carries (new-shape → its OWN headline/snippet/byline lead). `raw` is null (never reparsed). */
function mentionFromOutlet(o: Outlet, anchor: NormalizedMention): NormalizedMention {
  return {
    ...anchor,
    sourceName: o.name, // masthead
    url: o.url, // headline link
    reach: o.reach,
    outletUrl: o.outletUrl ?? null,
    raw: null,
    ...(o.title !== undefined ? { title: o.title } : {}),
    ...(o.snippet !== undefined ? { snippet: o.snippet } : {}),
    ...(o.author !== undefined ? { author: o.author } : {}),
    ...(o.mediaType !== undefined ? { mediaType: o.mediaType } : {}),
    ...(o.sentiment !== undefined ? { sentiment: o.sentiment } : {}),
    ...(o.publishedAt !== undefined ? { publishedAt: o.publishedAt } : {}),
    ...(o.matchedKeywords !== undefined ? { matchedKeywords: o.matchedKeywords } : {}),
  };
}

/**
 * Build a story card whose HEADLINE outlet is the highest-reach one, not necessarily the near-dup
 * anchor. `anchor` is the story's stable first mention (from `primary_mention_json`); `outlets` is the
 * full stored outlet list (including the anchor's own entry). The lead is the max-reach member (ties →
 * anchor, so cards stay stable); the rest — including the demoted anchor — become the footer outlet
 * list. A new-shape lead brings its own headline/snippet; an old-shape lead swaps only the masthead +
 * link and keeps the anchor's headline/snippet. The anchor's own entry is matched out by url/name so it
 * isn't double-listed.
 */
export function buildStoryAttachment(
  anchor: NormalizedMention,
  brief: BriefRule,
  outlets: Outlet[],
  otherBriefLabels: string[] = [],
  receivedAtMs: number | null = null,
): SlackAttachment {
  const anchorName = (anchor.sourceName ?? "").toLowerCase();
  const isAnchorEntry = (o: Outlet) => (anchor.url != null && o.url === anchor.url) || o.name.toLowerCase() === anchorName;

  // Lead = max reach among the anchor and the non-anchor outlets; anchor wins ties (stability).
  let leadMention = anchor;
  let leadEntry: Outlet | null = null; // the outlet chosen as lead (null ⇒ the anchor leads)
  let bestReach = anchor.reach ?? -1;
  for (const o of outlets) {
    if (isAnchorEntry(o)) continue;
    if ((o.reach ?? -1) > bestReach) {
      bestReach = o.reach ?? -1;
      leadEntry = o;
      leadMention = mentionFromOutlet(o, anchor);
    }
  }

  // The footer's "other outlets" = everything except whichever entry is now the headline.
  const rest = outlets.filter((o) => (leadEntry ? o !== leadEntry : !isAnchorEntry(o)));
  return buildAttachment(leadMention, brief, rest, otherBriefLabels, receivedAtMs);
}

/**
 * Stable, cheap (non-crypto FNV-1a) hash of a rendered attachment — stored per story so the redecode
 * backfill can tell whether re-rendering a card under the current code actually changed it, and only
 * chat.update the ones that did. Key order in `buildAttachment` is deterministic, so this is stable.
 */
export function attachmentHash(att: SlackAttachment): string {
  const s = JSON.stringify(att);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function buildPostPayload(
  m: NormalizedMention,
  brief: BriefRule,
  channel: string,
  receivedAtMs: number | null = null,
): SlackPostPayload {
  return {
    channel,
    attachments: [buildAttachment(m, brief, [], [], receivedAtMs)],
    unfurl_links: false,
    unfurl_media: false,
  };
}
