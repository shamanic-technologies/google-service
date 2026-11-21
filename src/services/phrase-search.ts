import { query } from "../db/client";
import { exchangedOnly, exchangedOrSpam } from "../lib/exchanged-mail";
import { loadPayloads, type SilverRow } from "./addressed-messages";
import { extractMessageBody, type BodyStatus } from "./message-body";
import { extractMessageLinks, type MessageLink } from "./message-links";

// An org's own Gmail mirror, searched by WHAT THE MAIL SAYS (BRAND-PROOF-LOGOS-1121).
//
// Why it exists: a script that finds, for any brand, the published articles
// quoting it reads the brand org's mailbox for the notifications announcing them
// ("Your insights are now live on <outlet>"). Picking candidates by sender would
// hard-code one press platform, and a mailbox of ~700k messages cannot be judged
// message by message. So candidates are picked by the phrases the caller's
// tactics name, and the caller judges each candidate (Jev) on its whole text.
//
// What is matched: the message's subject and Gmail's snippet (the opening ~200
// characters of its body, HTML entities escaped by Gmail), case-insensitive,
// as a plain substring (no pattern language: % and _ are literal). Both are
// silver columns, so the match never scans the bronze payloads (a payload scan
// measured 75 s on this mirror). A phrase found only deep inside a body is not
// matched.
//
// Narrow by construction: org-scoped in the SQL, only connected (not
// disconnecting) mailboxes, exchanged mail only unless includeSpam (drafts and
// trash never). A read, never a fetch: zero Google calls, no LLM, no spend.

export const MAX_PHRASES = 50;
export const DEFAULT_SEARCH_LIMIT = 50;
// Bounded text per message: whole enough for a judge to decide on a notification
// or a reply, never a 1 MB newsletter.
export const MAX_BODY_CHARS = 20_000;

export class PhraseSearchInputError extends Error {}

export interface PhraseSearchInput {
  phrases: string[];
  since?: string;
  until?: string;
  limit?: number;
  cursor?: string;
  includeSpam?: boolean;
}

export interface PhraseSearchMessage {
  id: string;
  mailbox: string;
  gmailMessageId: string;
  threadId: string | null;
  fromEmail: string | null;
  fromName: string | null;
  to: string[];
  cc: string[];
  subject: string | null;
  snippet: string | null;
  sentAt: string | null;
  labels: string[];
  matchedPhrases: string[];
  bodyText: string | null;
  bodyTruncated: boolean;
  bodyStatus: BodyStatus;
  links: MessageLink[];
}

export interface PhraseSearchPage {
  mailboxes: string[];
  reason: "no_google_account_connected" | null;
  messages: PhraseSearchMessage[];
  nextCursor: string | null;
}

// Plain substring for ILIKE: escape the LIKE metacharacters (backslash is the
// default escape character).
export const likePattern = (phrase: string): string => `%${phrase.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

// Opaque cursor = the (sentAt, id) of the last message served (newest first; a
// message without a date sorts last).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
interface Cursor {
  t: string | null;
  i: string;
}
export const encodeSearchCursor = (c: Cursor): string => Buffer.from(JSON.stringify(c), "utf-8").toString("base64url");
export const decodeSearchCursor = (raw: string): Cursor => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf-8"));
  } catch {
    throw new PhraseSearchInputError("invalid cursor");
  }
  const c = parsed as Partial<Cursor> | null;
  const validTime = c?.t === null || (typeof c?.t === "string" && !Number.isNaN(Date.parse(c.t)));
  if (!c || typeof c.i !== "string" || !UUID_RE.test(c.i) || !validTime) {
    throw new PhraseSearchInputError("invalid cursor");
  }
  return { t: c.t ?? null, i: c.i };
};

type SearchRow = SilverRow & { snippet: string | null };

export const searchOrgMessages = async (orgId: string, input: PhraseSearchInput): Promise<PhraseSearchPage> => {
  const phrases = [...new Set((input.phrases ?? []).map((p) => p.trim()).filter((p) => p.length > 0))];
  if (phrases.length === 0) throw new PhraseSearchInputError("at least one phrase is required");
  if (phrases.length > MAX_PHRASES) throw new PhraseSearchInputError(`at most ${MAX_PHRASES} phrases`);
  const cursor = input.cursor ? decodeSearchCursor(input.cursor) : null;
  const limit = input.limit ?? DEFAULT_SEARCH_LIMIT;

  const accounts = await query(
    `SELECT id, lower(google_account_email) AS email FROM google_oauth_tokens WHERE org_id = $1 AND disconnected_at IS NULL`,
    [orgId]
  );
  if (accounts.rows.length === 0) {
    return { mailboxes: [], reason: "no_google_account_connected", messages: [], nextCursor: null };
  }
  const mailboxById = new Map<string, string>(accounts.rows.map((r) => [r.id as string, r.email as string]));
  const mailboxes = [...new Set(mailboxById.values())].sort();

  // The text expression is byte-equal to the trigram index built after boot
  // (search-index.ts), so the planner can carry the ILIKE on it.
  const page = await query(
    `SELECT s.id, s.google_account_id, s.org_id, s.gmail_message_id, s.thread_id,
            s.from_email, s.from_name, s.to_emails, s.cc_emails, s.subject, s.snippet, s.sent_at, s.labels
       FROM gmail_messages_silver s
      WHERE s.org_id = $1
        AND s.google_account_id = ANY($2::uuid[])
        AND (COALESCE(s.subject, '') || E'\\n' || COALESCE(s.snippet, '')) ILIKE ANY($3::text[])
        AND ${input.includeSpam === true ? exchangedOrSpam("s") : exchangedOnly("s")}
        AND ($4::timestamptz IS NULL OR s.sent_at >= $4::timestamptz)
        AND ($5::timestamptz IS NULL OR s.sent_at < $5::timestamptz)
        AND ($6::uuid IS NULL
             OR (COALESCE(s.sent_at, '-infinity'::timestamptz), s.id)
              < (COALESCE($7::timestamptz, '-infinity'::timestamptz), $6::uuid))
      ORDER BY COALESCE(s.sent_at, '-infinity'::timestamptz) DESC, s.id DESC
      LIMIT $8`,
    [
      orgId,
      [...mailboxById.keys()],
      phrases.map(likePattern),
      input.since ?? null,
      input.until ?? null,
      cursor?.i ?? null,
      cursor?.t ?? null,
      limit + 1,
    ]
  );

  const hasMore = page.rows.length > limit;
  const rows = (hasMore ? page.rows.slice(0, limit) : page.rows) as unknown as SearchRow[];
  const payloads = await loadPayloads(rows);
  const lowered = phrases.map((p) => [p, p.toLowerCase()] as const);

  const messages = rows.map((r): PhraseSearchMessage => {
    const mailbox = mailboxById.get(r.google_account_id) ?? "";
    const body = extractMessageBody(payloads.get(`${r.org_id}:${r.gmail_message_id}`) ?? null);
    const haystack = `${r.subject ?? ""}\n${r.snippet ?? ""}`.toLowerCase();
    const text = body.text;
    const bodyTruncated = text !== null && text.length > MAX_BODY_CHARS;
    return {
      id: `${mailbox}:${r.gmail_message_id}`,
      mailbox,
      gmailMessageId: r.gmail_message_id,
      threadId: r.thread_id,
      fromEmail: r.from_email,
      fromName: r.from_name,
      to: Array.isArray(r.to_emails) ? r.to_emails : [],
      cc: Array.isArray(r.cc_emails) ? r.cc_emails : [],
      subject: r.subject,
      snippet: r.snippet,
      sentAt: r.sent_at instanceof Date ? r.sent_at.toISOString() : null,
      labels: Array.isArray(r.labels) ? r.labels : [],
      matchedPhrases: lowered.filter(([, low]) => haystack.includes(low)).map(([p]) => p),
      bodyText: bodyTruncated ? text.slice(0, MAX_BODY_CHARS) : text,
      bodyTruncated,
      bodyStatus: body.status,
      links: extractMessageLinks(body.html, body.text),
    };
  });

  const last = rows[rows.length - 1];
  return {
    mailboxes,
    reason: null,
    messages,
    nextCursor:
      hasMore && last
        ? encodeSearchCursor({ t: last.sent_at instanceof Date ? last.sent_at.toISOString() : null, i: last.id })
        : null,
  };
};
