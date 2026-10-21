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
export const exchangedOnly = (alias: string): string =>
  `NOT (COALESCE(${alias}.labels, '[]'::jsonb) ?| ARRAY[${NOT_EXCHANGED_LABELS.map((l) => `'${l}'`).join(", ")}]::text[])`;
