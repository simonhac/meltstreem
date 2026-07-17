import type { SlackAttachment } from "@/lib/slack/format";

/*
 * Rendering one stored SlackAttachment (DocResult.blocks) as an HTML replica of
 * the classic Slack attachment card. Two DIFFERENT escaping jobs — do not mix:
 *
 *   escHtml(raw)         RAW strings + attribute values (title, author_name,
 *                        footer, URLs). Escapes & < > ".
 *   mrkdwnText(escaped)  strings ALREADY &<>-escaped by escapeMrkdwn (the
 *                        attachment `text` and `fields[].value`). MUST NOT
 *                        re-escape — only turns `x` code spans into
 *                        <code class="sr-inline-code">x</code> (mrtippy's pill).
 */

/** Escape a RAW string for safe use in HTML text OR an attribute value. */
export function escHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Convert an ALREADY-&<>-escaped Slack mrkdwn fragment to HTML. Does NOT
 * re-escape (that would double-encode &amp; → &amp;amp;). Only transforms
 * backtick code spans into keyword pills. Safe against XSS: the only
 * HTML-significant chars (& < >) are already entities and the sole tag we
 * introduce is <code>. `String.replace` never re-scans its own output, so a pill
 * can't be double-wrapped; the interior class `[^`]+` keeps every match a
 * minimal balanced pair (matching how Slack itself pairs backticks).
 */
export function mrkdwnText(alreadyEscaped: string): string {
  return (
    alreadyEscaped
      // Slack link syntax <url|label> → anchor (e.g. the trailing ↗ "go direct" link). The url is
      // already &<>-escaped (attribute-safe) so we don't re-escape; only http(s) matches (never
      // javascript:), and the quote is hardened defensively. Runs before the pill pass.
      .replace(
        /<(https?:\/\/[^|>\s]+)\|([^>]*)>/g,
        (_m, url, label) =>
          `<a class="sr-link" href="${url.replace(/"/g, "&quot;")}" target="_blank" rel="noopener noreferrer">${label}</a>`,
      )
      .replace(/`([^`]+)`/g, '<code class="sr-inline-code">$1</code>')
  );
}

/** Allow only http/https URLs into href/src; returns an escaped URL or null. */
export function safeUrl(raw: string | undefined | null): string | null {
  if (!raw || !/^https?:\/\//i.test(raw)) return null;
  return escHtml(raw);
}

/** Decision → pill colour (only shown inside the click-to-expand debug panel). */
export const DECISION_COLORS: Record<string, string> = {
  posted: "#16794e",
  merged: "#1f6f8a",
  preview: "#8a6d00",
  dropped: "#8a1f1f",
  duplicate: "#555555",
  logged: "#555555",
  error: "#8a1f1f",
};

export function decisionPill(decision: string): string {
  const color = DECISION_COLORS[decision] ?? "#555555";
  return `<span class="deco-pill" style="background:${color}">${escHtml(decision)}</span>`;
}

/**
 * Render one stored SlackAttachment as a Slack-classic-attachment card body
 * (the `.att-main` inner — the caller wraps it with the `.att` article and the
 * inline debug panel). Reuses mrtippy's `.sr-*` classes for the pills, link,
 * field grid and footer.
 */
export function renderCardBody(att: SlackAttachment): string {
  // Header: optional logo + masthead.
  const logo = safeUrl(att.author_icon);
  const logoImg = logo
    ? `<img class="att-logo" src="${logo}" alt="" loading="lazy" referrerpolicy="no-referrer">`
    : "";
  const mastheadHref = safeUrl(att.author_link);
  const masthead = att.author_name
    ? mastheadHref
      ? `<a class="att-masthead sr-link" href="${mastheadHref}" target="_blank" rel="noopener noreferrer">${escHtml(att.author_name)}</a>`
      : `<span class="att-masthead">${escHtml(att.author_name)}</span>`
    : "";
  const head = logoImg || masthead ? `<div class="att-head">${logoImg}${masthead}</div>` : "";

  // Headline: link when title_link is a safe http(s) URL, else a plain styled line.
  let title = "";
  if (att.title) {
    const href = safeUrl(att.title_link);
    title = href
      ? `<a class="att-title sr-link" href="${href}" target="_blank" rel="noopener noreferrer">${escHtml(att.title)}</a>`
      : `<div class="att-title att-title--plain">${escHtml(att.title)}</div>`;
  }

  // Excerpt: already &<>-escaped mrkdwn — only pill-transform, never re-escape.
  const text = att.text ? `<div class="att-text">${mrkdwnText(att.text)}</div>` : "";

  // Footer meta line (context block), led by the media-type icon (footer_icon), mirroring Slack's
  // 16px footer glyph. The brief and byline now live in att.footer / att.author_name respectively.
  const footerIconUrl = safeUrl(att.footer_icon);
  const footerIcon = footerIconUrl
    ? `<img class="att-footer-icon" src="${footerIconUrl}" alt="" loading="lazy" referrerpolicy="no-referrer">`
    : "";
  const footer = att.footer
    ? `<div class="sr-context att-footer">${footerIcon}<span class="sr-context-item">${escHtml(att.footer)}</span></div>`
    : "";

  return `<div class="att-main">${head}${title}${text}${footer}</div>`;
}
