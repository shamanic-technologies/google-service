import { query } from "../db/client";
import { resolveOwnerAddresses } from "./owner-addresses";

// Who has this org's connected mailbox been IN CONVERSATION with?
//
// The discovery half of the per-person conversation read: that read answers
// "the whole exchange with ONE address", this one lists the addresses worth
// opening. A pure read of silver — it never calls Google.
//
// "In conversation" = the mailbox owner WROTE to them (they sit in To or Cc of a
// message sent from one of the owner's own addresses). Pure inbound noise
// (newsletters, notifications: 215k distinct senders on the first org, vs a few
// hundred people the owner wrote to) is excluded by construction.
//
// Owner addresses: `resolveOwnerAddresses` (connected accounts + SENT senders),
// the same definition the conversation read labels "outbound" with.
//
// Reconciliation with GET /orgs/google/conversation: that read matches an address
// on lower(from_email), to_emails and cc_emails. Every address listed here was
// found in to_emails/cc_emails of at least one message, lower-cased the same way,
// so it opens to a non-empty conversation there.

export interface Correspondent {
  email: string;
  name: string | null;
  nameSource: "message" | "contact" | null;
  outboundMessages: number;
  inboundMessages: number;
  twoWay: boolean;
  firstMessageAt: string | null;
  lastMessageAt: string | null;
  lastOutboundAt: string | null;
  lastInboundAt: string | null;
}

export interface CorrespondentsPage {
  ownerAddresses: string[];
  total: number;
  twoWayTotal: number;
  limit: number;
  offset: number;
  correspondents: Correspondent[];
}

export type CorrespondentsResult =
  | { connected: true; page: CorrespondentsPage }
  | { connected: false; reason: "no_google_account_connected" };

const DEFAULT_LIMIT = 500;

const toIso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : null);

export const listCorrespondents = async (
  orgId: string,
  opts: { limit?: number; offset?: number } = {}
): Promise<CorrespondentsResult> => {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const offset = opts.offset ?? 0;

  const owner = await resolveOwnerAddresses(orgId);
  if (!owner.connected) {
    return { connected: false, reason: "no_google_account_connected" };
  }
  const ownerAddresses = owner.addresses;

  // One statement. Outbound = messages FROM an owner address, exploded on their
  // To + Cc (each recipient counted once per message). Inbound = every message
  // FROM that recipient, counted INDEX-ONLY on idx_gmail_messages_silver_from_plain_sent
  // for the few hundred recipients only — never a scan of the inbound noise. (A
  // recipient can be a busy address: 166k inbound rows across the first org's 453
  // recipients, which took 12s cold through heap fetches before that index.)
  // Inbound matches the PLAIN from_email: silver lower-cases it at ingest, so it
  // equals lower(from_email) (the conversation read's match) and the index stays
  // index-only-scannable.
  const rows = await query(
    `WITH outm AS (
        SELECT r.addr, s.sent_at
          FROM gmail_messages_silver s
          CROSS JOIN LATERAL (
            SELECT DISTINCT lower(btrim(x)) AS addr
              FROM jsonb_array_elements_text(s.to_emails || s.cc_emails) AS x
          ) r
         WHERE s.org_id = $1
           AND lower(s.from_email) = ANY($2::text[])
           AND r.addr <> ''
           AND NOT (r.addr = ANY($2::text[]))
      ),
      outagg AS (
        SELECT addr, count(*)::int AS n, min(sent_at) AS first_at, max(sent_at) AS last_at
          FROM outm GROUP BY addr
      ),
      inagg AS (
        SELECT s.from_email AS addr,
               count(*)::int AS n,
               min(s.sent_at) AS first_at,
               max(s.sent_at) AS last_at
          FROM gmail_messages_silver s
         WHERE s.org_id = $1
           AND s.from_email = ANY(ARRAY(SELECT addr FROM outagg))
         GROUP BY 1
      ),
      joined AS (
        SELECT o.addr,
               o.n AS out_n,
               COALESCE(i.n, 0) AS in_n,
               o.last_at AS last_out,
               i.last_at AS last_in,
               LEAST(o.first_at, i.first_at) AS first_at,
               GREATEST(o.last_at, i.last_at) AS last_at
          FROM outagg o LEFT JOIN inagg i ON i.addr = o.addr
      )
      SELECT j.*,
             nm.from_name AS msg_name,
             c.display_name AS contact_name,
             count(*) OVER () ::int AS total,
             (count(*) FILTER (WHERE j.in_n > 0) OVER ())::int AS two_way_total
        FROM joined j
        -- The name they sign with on their most recent message that carries one
        -- (walks idx_gmail_messages_silver_from_plain_sent newest-first).
        -- Bounded to their 20 most recent messages: a busy sender that never
        -- signs (a notification address) would otherwise walk all its rows.
        LEFT JOIN LATERAL (
          SELECT btrim(t.from_name) AS from_name
            FROM (
              SELECT s.from_name, s.sent_at FROM gmail_messages_silver s
               WHERE s.org_id = $1 AND s.from_email = j.addr
               ORDER BY s.sent_at DESC NULLS LAST
               LIMIT 20
            ) t
           WHERE t.from_name IS NOT NULL AND btrim(t.from_name) <> ''
           ORDER BY t.sent_at DESC NULLS LAST
           LIMIT 1
        ) nm ON j.in_n > 0
        LEFT JOIN LATERAL (
          SELECT display_name FROM google_contacts_silver c
           WHERE c.org_id = $1 AND lower(c.primary_email) = j.addr
             AND c.display_name IS NOT NULL AND btrim(c.display_name) <> ''
           ORDER BY c.resource_name
           LIMIT 1
        ) c ON true
       ORDER BY j.last_at DESC NULLS LAST, j.addr ASC
       LIMIT $3 OFFSET $4`,
    [orgId, ownerAddresses, limit, offset]
  );

  let total = 0;
  let twoWayTotal = 0;
  if (rows.rows.length > 0) {
    total = Number(rows.rows[0].total);
    twoWayTotal = Number(rows.rows[0].two_way_total);
  } else if (offset > 0) {
    // Paged past the end: the window functions returned nothing, so count separately.
    const t = await countCorrespondents(orgId, ownerAddresses);
    total = t.total;
    twoWayTotal = t.twoWayTotal;
  }

  const correspondents: Correspondent[] = rows.rows.map((r) => {
    const msgName = (r.msg_name as string | null) ?? null;
    const contactName = (r.contact_name as string | null) ?? null;
    const inbound = Number(r.in_n);
    return {
      email: r.addr as string,
      name: msgName ?? contactName,
      nameSource: msgName ? "message" : contactName ? "contact" : null,
      outboundMessages: Number(r.out_n),
      inboundMessages: inbound,
      twoWay: inbound > 0,
      firstMessageAt: toIso(r.first_at),
      lastMessageAt: toIso(r.last_at),
      lastOutboundAt: toIso(r.last_out),
      lastInboundAt: toIso(r.last_in),
    };
  });

  return {
    connected: true,
    page: { ownerAddresses, total, twoWayTotal, limit, offset, correspondents },
  };
};

const countCorrespondents = async (
  orgId: string,
  ownerAddresses: string[]
): Promise<{ total: number; twoWayTotal: number }> => {
  const res = await query(
    `WITH rec AS (
        SELECT DISTINCT lower(btrim(x)) AS addr
          FROM gmail_messages_silver s
          CROSS JOIN LATERAL jsonb_array_elements_text(s.to_emails || s.cc_emails) AS x
         WHERE s.org_id = $1 AND lower(s.from_email) = ANY($2::text[])
      )
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM gmail_messages_silver s
                WHERE s.org_id = $1 AND s.from_email = rec.addr
             ))::int AS two_way_total
        FROM rec
       WHERE addr <> '' AND NOT (addr = ANY($2::text[]))`,
    [orgId, ownerAddresses]
  );
  const row = res.rows[0] ?? { total: 0, two_way_total: 0 };
  return { total: Number(row.total), twoWayTotal: Number(row.two_way_total) };
};
