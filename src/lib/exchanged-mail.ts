// Which mirrored messages were really EXCHANGED with someone (GMAIL-DRAFTS-AS-SENT-1022).
//
// The mirror stores every message Gmail holds, drafts included: a saved draft to a
// prospect carries the prospect in To, the owner in From, and the label DRAFT. Served
// as mail, it reads as a second "Sent" line in the Unibox for an email the person
// never received. SPAM and TRASH are not an exchange either.
//
// Every read that serves a person's mail (conversation, addressed messages, a
// participant's thread, correspondents, the reply-thread picker) filters with this
// ONE predicate. The rows stay stored: they are only never served as exchanged mail.
export const NOT_EXCHANGED_LABELS = ["DRAFT", "SPAM", "TRASH"] as const;

/**
 * SQL predicate: the silver row `alias` is exchanged mail. A message with no silver
 * row (LEFT JOIN) has no known label and is kept.
 */
const excludingLabels = (alias: string, labels: readonly string[]): string =>
  `NOT (COALESCE(${alias}.labels, '[]'::jsonb) ?| ARRAY[${labels.map((l) => `'${l}'`).join(", ")}]::text[])`;

export const exchangedOnly = (alias: string): string => excludingLabels(alias, NOT_EXCHANGED_LABELS);

// PF-CLOUDFLARE-1120: a prospect reply forwarded (Cloudflare Email Routing) into the
// staff Gmail can be filed in SPAM by Gmail; it is still a reply. A caller that
// recovers such forwards asks `includeSpam` and gets SPAM rows too. A draft was never
// sent and trash was thrown away: neither is ever served.
export const NEVER_SERVED_LABELS = ["DRAFT", "TRASH"] as const;

/** SQL predicate: `exchangedOnly` that keeps rows Gmail labelled SPAM. */
export const exchangedOrSpam = (alias: string): string => excludingLabels(alias, NEVER_SERVED_LABELS);
