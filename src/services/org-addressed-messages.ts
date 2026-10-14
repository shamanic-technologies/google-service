import { query } from "../db/client";
import { resolveOwnerAddresses } from "./owner-addresses";
import {
  AddressedMessagesInputError,
  DEFAULT_PAGE_LIMIT,
  MAX_ADDRESSES,
  decodeCursor,
  encodeCursor,
  loadPayloads,
  shapeAddressedMessage,
  type AddressedMessage,
  type SilverRow,
} from "./addressed-messages";

// An ORG's own connected Gmail, read for the mail it exchanged with a batch of
// people (its prospects): every mirrored message sent FROM one of them, or with
// one of them in To/Cc. The org-scoped twin of the staff addressed-messages
// read, same per-message shape, so one consumer parser reads both.
//
// Why it exists: a client who connected its Gmail and answers a cold-email
// prospect by hand from it holds that exchange only here. The outreach side
// (instantly-service) folds it into the prospect's thread, once per org with a
// connected mailbox, every ~15 min, with the prospect addresses it knows.
//
// Narrow by construction:
//   - org-scoped IN THE QUERY (org_id = the caller's org): another org's mail
//     can never be reached by filtering afterwards;
//   - a requested address that is one of the org's OWN addresses (connected
//     account or send-as alias) is dropped and reported in ignoredAddresses:
//     "mail to/from me" would be the whole mailbox;
//   - matching is index-carried (btree on from_email, GIN on to/cc), never a
//     payload scan; the matching ids are collected first, then keyset-paged.
// A read, never a fetch: zero Google calls, no cleaning, no judgment.

export interface OrgAddressedMessagesInput {
  addresses: string[];
  since?: string;
  until?: string;
  limit?: number;
  cursor?: string;
}

// "outbound" = sent FROM one of the org's own addresses (the client's side);
// "inbound" = sent FROM one of the requested addresses (the prospect's side);
// "other" = a third party writing with a requested address in To/Cc.
export type OrgAddressedDirection = "inbound" | "outbound" | "other";

export type OrgAddressedMessage = Omit<AddressedMessage, "direction"> & {
  direction: OrgAddressedDirection;
  // Which requested addresses the message involves, in From, To or Cc.
  matchedAddresses: string[];
};

export interface OrgAddressedMessagesPage {
  mailboxes: string[];
  ownerAddresses: string[];
  ignoredAddresses: string[];
  messages: OrgAddressedMessage[];
  nextCursor: string | null;
}

export type OrgAddressedMessagesResult =
  | { found: true; page: OrgAddressedMessagesPage }
  | { found: false; reason: "no_google_account_connected" };

const normAddress = (a: string): string => a.trim().toLowerCase();

export const getOrgAddressedMessages = async (
  orgId: string,
  input: OrgAddressedMessagesInput
): Promise<OrgAddressedMessagesResult> => {
  const requested = [...new Set((input.addresses ?? []).map(normAddress).filter((a) => a.length > 0))];
  if (requested.length === 0) throw new AddressedMessagesInputError("at least one address is required");
  if (requested.length > MAX_ADDRESSES) throw new AddressedMessagesInputError(`at most ${MAX_ADDRESSES} addresses`);
  const afterId = input.cursor ? decodeCursor(input.cursor) : null;
  const limit = input.limit ?? DEFAULT_PAGE_LIMIT;

  const accounts = await query(
    `SELECT id, lower(google_account_email) AS email FROM google_oauth_tokens WHERE org_id = $1 AND disconnected_at IS NULL`,
    [orgId]
  );
  if (accounts.rows.length === 0) return { found: false, reason: "no_google_account_connected" };
  const mailboxById = new Map<string, string>(accounts.rows.map((r) => [r.id as string, r.email as string]));

  const owner = await resolveOwnerAddresses(orgId);
  const ownerAddresses = owner.connected ? owner.addresses : [...new Set(mailboxById.values())].sort();
  const ownerSet = new Set(ownerAddresses);
  const addresses = requested.filter((a) => !ownerSet.has(a));
  const ignoredAddresses = requested.filter((a) => ownerSet.has(a));

  const mailboxes = [...new Set(mailboxById.values())].sort();
  if (addresses.length === 0) {
    return { found: true, page: { mailboxes, ownerAddresses, ignoredAddresses, messages: [], nextCursor: null } };
  }

  // Matching rows first, from the indexes (BitmapOr of the from_email btree and
  // the to/cc GINs), then the page in primary-key order: a stable total order
  // that includes messages without a date. The page is cut from the
  // materialized hits, never re-joined to the table: measured on the 682k
  // mirror, a re-join planned a merge join walking the primary key (8.9 s).
  const page = await query(
    `WITH hits AS MATERIALIZED (
       SELECT s.id, s.google_account_id, s.org_id, s.gmail_message_id, s.thread_id,
              s.from_email, s.from_name, s.to_emails, s.cc_emails, s.subject, s.sent_at, s.labels
         FROM gmail_messages_silver s
        WHERE s.org_id = $1
          AND (s.from_email = ANY($2::text[]) OR s.to_emails ?| $2::text[] OR s.cc_emails ?| $2::text[])
          AND ($3::uuid IS NULL OR s.id > $3::uuid)
          AND ($4::timestamptz IS NULL OR s.sent_at >= $4::timestamptz)
          AND ($5::timestamptz IS NULL OR s.sent_at < $5::timestamptz)
     )
     SELECT * FROM hits ORDER BY id LIMIT $6`,
    [orgId, addresses, afterId, input.since ?? null, input.until ?? null, limit + 1]
  );

  const hasMore = page.rows.length > limit;
  const rows = (hasMore ? page.rows.slice(0, limit) : page.rows) as unknown as SilverRow[];
  const payloads = await loadPayloads(rows);

  const addressSet = new Set(addresses);
  const isRequested = (a: string) => addressSet.has(a);

  const messages = rows.map((r): OrgAddressedMessage => {
    const from = r.from_email ?? "";
    const direction: OrgAddressedDirection = ownerSet.has(from)
      ? "outbound"
      : addressSet.has(from)
        ? "inbound"
        : "other";
    const shaped = shapeAddressedMessage(
      r,
      payloads.get(`${r.org_id}:${r.gmail_message_id}`) ?? null,
      mailboxById.get(r.google_account_id) ?? "",
      direction,
      isRequested
    );
    const participants = [from, ...shaped.to, ...shaped.cc];
    return { ...shaped, matchedAddresses: [...new Set(participants.filter(isRequested))] };
  });

  return {
    found: true,
    page: {
      mailboxes,
      ownerAddresses,
      ignoredAddresses,
      messages,
      nextCursor: hasMore ? encodeCursor(rows[rows.length - 1].id) : null,
    },
  };
};
