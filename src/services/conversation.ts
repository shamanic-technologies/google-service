import { query } from "../db/client";
import type { GmailMessage } from "./google-api";
import { extractMessageBody, type BodyStatus } from "./message-body";

// Read the whole exchange with one person out of the Gmail mirror.
//
// This is a READ: it never calls Google. The mirror already holds both
// directions of these conversations — including the replies that never reached
// the outreach provider because a forwarding rule drained the sending mailbox
// before the provider saw them.
//
// Org scoping is IN the query (every table is filtered on org_id); a caller
// cannot reach another org's mail by filtering afterwards.

export type ConversationStatus = "ok" | "partial" | "unreadable";
export type MessageDirection = "inbound" | "outbound" | "other";

export interface ConversationMessage {
  gmailMessageId: string;
  threadId: string;
  direction: MessageDirection;
  fromEmail: string | null;
  fromName: string | null;
  to: string[];
  subject: string | null;
  snippet: string | null;
  sentAt: string | null;
  labels: string[];
  bodyText: string | null;
  bodyHtml: string | null;
  bodyStatus: BodyStatus;
}

export interface ConversationThread {
  threadId: string;
  subject: string | null;
  firstMessageAt: string | null;
  lastMessageAt: string | null;
  messageCount: number;
  messages: ConversationMessage[];
}

export interface Conversation {
  address: string;
  status: ConversationStatus;
  threadCount: number;
  messageCount: number;
  truncated: boolean;
  threads: ConversationThread[];
}

export type ConversationResult =
  | { found: true; conversation: Conversation }
  // Nobody has this exchange. `reason` distinguishes "this org has never
  // connected a Google account" from "connected, and there is no mail with this
  // address" — a caller renders those differently.
  | { found: false; reason: "no_google_account_connected" | "no_messages" };

interface MessageRow {
  gmail_message_id: string;
  thread_id: string | null;
  payload: unknown;
  fetched_at: Date;
  from_email: string | null;
  from_name: string | null;
  to_emails: string[] | null;
  subject: string | null;
  snippet: string | null;
  sent_at: Date | null;
  labels: string[] | null;
}

const toIso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : null);

const DEFAULT_LIMIT = 200;

export const getConversation = async (
  orgId: string,
  addressRaw: string,
  limit: number = DEFAULT_LIMIT
): Promise<ConversationResult> => {
  const address = addressRaw.trim().toLowerCase();

  const accounts = await query(
    `SELECT lower(google_account_email) AS email FROM google_oauth_tokens WHERE org_id = $1`,
    [orgId]
  );
  if (accounts.rows.length === 0) {
    return { found: false, reason: "no_google_account_connected" };
  }
  const ownEmails = new Set(
    accounts.rows.map((r) => (r.email as string | null) ?? "").filter((e) => e.length > 0)
  );

  // Threads this person appears in, matched entirely from INDEXES: lower(from_email)
  // as sender, GIN over to_emails and cc_emails as recipient. Every message of a
  // matched thread is then returned, so the owner's own answer is part of the
  // exchange even when the prospect is only a Cc on it.
  //
  // Deliberately NO `payload::text ILIKE` fallback over bronze: on the real
  // mirror (~660k messages) that scan took 75s and it ran on the MOST common
  // question — an address we have never mailed — so the honest "nobody has this
  // exchange" answer was the slowest one in the endpoint. Silver is written at
  // ingest and rebuilt for every bronze row on boot, so From/To/Cc coverage is
  // complete without it.
  const matched = await query(
    `SELECT DISTINCT thread_id
       FROM gmail_messages_silver
       WHERE org_id = $1
         AND thread_id IS NOT NULL
         AND (lower(from_email) = $2 OR to_emails ? $2 OR cc_emails ? $2)`,
    [orgId, address]
  );

  const threadIds = matched.rows
    .map((r) => r.thread_id as string | null)
    .filter((t): t is string => t !== null);

  if (threadIds.length === 0) return { found: false, reason: "no_messages" };

  // Newest `limit + 1` first so a very long exchange keeps its most recent
  // messages, then reversed to oldest-first for the caller.
  const rows = await query(
    `SELECT m.gmail_message_id, m.thread_id, m.payload, m.fetched_at,
            s.from_email, s.from_name, s.to_emails, s.subject, s.snippet, s.sent_at, s.labels
       FROM gmail_messages_raw m
       LEFT JOIN gmail_messages_silver s
         ON s.org_id = m.org_id AND s.gmail_message_id = m.gmail_message_id
       WHERE m.org_id = $1 AND m.thread_id = ANY($2::text[])
       ORDER BY COALESCE(s.sent_at, m.fetched_at) DESC, m.gmail_message_id DESC
       LIMIT $3`,
    [orgId, threadIds, limit + 1]
  );

  const truncated = rows.rows.length > limit;
  const kept = (truncated ? rows.rows.slice(0, limit) : rows.rows) as unknown as MessageRow[];
  const ordered = [...kept].reverse(); // oldest first

  const messages: ConversationMessage[] = ordered.map((row) => {
    const body = extractMessageBody(row.payload as GmailMessage);
    const fromEmail = row.from_email ? row.from_email.toLowerCase() : null;
    const direction: MessageDirection =
      fromEmail === address ? "inbound" : fromEmail && ownEmails.has(fromEmail) ? "outbound" : "other";

    return {
      gmailMessageId: row.gmail_message_id,
      threadId: row.thread_id ?? "",
      direction,
      fromEmail: row.from_email ?? null,
      fromName: row.from_name ?? null,
      to: row.to_emails ?? [],
      subject: row.subject ?? null,
      snippet: row.snippet ?? null,
      sentAt: toIso(row.sent_at) ?? toIso(row.fetched_at),
      labels: row.labels ?? [],
      bodyText: body.text,
      bodyHtml: body.html,
      bodyStatus: body.status,
    };
  });

  // Group into threads, preserving the oldest-first order both between threads
  // (by their first message) and inside each thread.
  const byThread = new Map<string, ConversationMessage[]>();
  for (const m of messages) {
    const list = byThread.get(m.threadId);
    if (list) list.push(m);
    else byThread.set(m.threadId, [m]);
  }

  const threads: ConversationThread[] = [...byThread.entries()].map(([threadId, msgs]) => ({
    threadId,
    subject: msgs.find((m) => m.subject !== null)?.subject ?? null,
    firstMessageAt: msgs[0]?.sentAt ?? null,
    lastMessageAt: msgs[msgs.length - 1]?.sentAt ?? null,
    messageCount: msgs.length,
    messages: msgs,
  }));

  const unreadable = messages.filter((m) => m.bodyStatus === "unavailable").length;
  const status: ConversationStatus =
    unreadable === 0 ? "ok" : unreadable === messages.length ? "unreadable" : "partial";

  return {
    found: true,
    conversation: {
      address,
      status,
      threadCount: threads.length,
      messageCount: messages.length,
      truncated,
      threads,
    },
  };
};
