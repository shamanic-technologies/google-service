// The links a mirrored message carries, read from its stored body (BRAND-PROOF-LOGOS-1121).
//
// A caller that keeps facts out of a message (an article URL announced in a press
// notification) must never re-parse HTML itself: the anchors are served here,
// with their visible text when the HTML gives one. This is structure the mail
// MARKS (an <a href>), never a judgment of what the link means: every http(s)
// link is served verbatim, tracking redirects included; the caller decides.

export interface MessageLink {
  url: string;
  // Visible text of the anchor (or the alt of the image it wraps); null for a bare
  // URL in the plain-text part or an anchor with no readable text.
  text: string | null;
}

export const MAX_LINKS = 200;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export const decodeEntities = (s: string): string =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });

const isWebUrl = (u: string): boolean => /^https?:\/\//i.test(u);

const ANCHOR_RE = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
const HREF_RE = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const IMG_ALT_RE = /<img\b[^>]*\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
// A bare URL in text: stops at whitespace and the brackets mail clients wrap it in.
const BARE_URL_RE = /https?:\/\/[^\s<>"'()[\]{}]+/gi;

const anchorText = (inner: string): string | null => {
  const text = decodeEntities(inner.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
  if (text.length > 0) return text;
  const alt = inner.match(IMG_ALT_RE);
  const altText = alt ? decodeEntities(alt[1] ?? alt[2] ?? "").replace(/\s+/g, " ").trim() : "";
  return altText.length > 0 ? altText : null;
};

const trimTrailingPunctuation = (u: string): string => u.replace(/[.,;:!?]+$/, "");

/**
 * Links of a message, in reading order: every http(s) anchor of the HTML part with
 * its text, then the bare URLs of the plain-text part not already served. Deduped
 * on (url, text); at most MAX_LINKS.
 */
export const extractMessageLinks = (html: string | null, text: string | null): MessageLink[] => {
  const links: MessageLink[] = [];
  const seen = new Set<string>();
  const urls = new Set<string>();
  const push = (url: string, label: string | null) => {
    const key = `${url}\u0000${label ?? ""}`;
    if (seen.has(key) || links.length >= MAX_LINKS) return;
    seen.add(key);
    urls.add(url);
    links.push({ url, text: label });
  };

  if (html) {
    for (const m of html.matchAll(ANCHOR_RE)) {
      const href = m[1].match(HREF_RE);
      if (!href) continue;
      const url = decodeEntities((href[1] ?? href[2] ?? href[3] ?? "").trim());
      if (!isWebUrl(url)) continue;
      push(url, anchorText(m[2]));
    }
  }
  if (text) {
    for (const m of text.matchAll(BARE_URL_RE)) {
      const url = trimTrailingPunctuation(m[0]);
      if (urls.has(url)) continue;
      push(url, null);
    }
  }
  return links;
};
