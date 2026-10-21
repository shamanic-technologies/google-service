import crypto from "crypto";
import { query } from "../db/client";
import {
  GoogleApiError,
  getGmailMessage,
  isInsufficientScopeError,
  listGmailSendAs,
  sendGmailMessage,
  withTokenRetry,
  type GmailMessage,
} from "./google-api";
import { createAccessTokenProvider, getGoogleAccountById } from "./google-tokens";
import { GMAIL_SEND_SCOPE } from "./google-oauth";
import { upsertMessage } from "./gmail-ingest";
import { parseMessageIdList } from "./addressed-messages";
import type { CallerContext } from "./key-service";

// A follow-up that lands IN the person's latest Gmail thread, FROM the address
// they wrote to / were answered from (RIGHT-MOMENT-OR-LATER-1014, owner
// 2026-10-14). Two halves:
//
// - findLatestThread: a READ of the mirror (no Google call). The thread holding
//   the person's latest exchange with this org's connected mailboxes, and the
//   owner address that answers it. The caller (email-gateway) compares its
//   lastMessageAt with the other transport's latest exchange to pick the thread.
// - replyInThread: sends ONE reply in that thread through the Gmail API, with
//   the threading headers (In-Reply-To / References, `Re:` subject), then
//   records the sent message in the mirror like any ingested one.
//
// "Ours" for a thread is decided per MAILBOX: the account email plus every
// sender of a SENT-labelled message of that same account (its send-as aliases).
// A thread where no owner address of its mailbox took part (a message forwarded
// in from another mailbox) has nobody to answer from and is skipped.

export type ThreadDirection = "inbound" | "outbound";

export interface LatestThread {
  threadId: string;
  googleAccountId: string;
  mailbox: string;
  /** The owner address the reply is written from (they wrote to it / were answered from it). */
  fromAddress: string;
  lastMessageAt: string | null;
  /** inbound = the latest message is the person's; outbound = ours. */
  lastMessageDirection: ThreadDirection | "other";
  subject: string | null;
  /** The mailbox's grant includes gmail.send. */
  sendPermission: boolean;
}

export type LatestThreadResult =
  | { found: true; thread: LatestThread }
  | { found: false; reason: "no_google_account_connected" | "no_messages" };

// Labels that mean "not an exchange": never answer into them.
const EXCLUDED_LABELS = ["DRAFT", "SPAM", "TRASH"];
// Messages read per lookup, newest first. A person's whole history with one
// org is far below this; the newest threads are the ones that matter.
const MESSAGE_SCAN_LIMIT = 300;

interface ThreadMessageRow {
  google_account_id: string;
  thread_id: string;
  gmail_message_id: string;
  from_email: string | null;
  to_emails: string[] | null;
  cc_emails: string[] | null;
  subject: string | null;
  sent_at: Date | null;
  labels: string[] | null;
}

interface AccountRow {
  id: string;
  email: string;
  scopes: string;
}

const lc = (v: string | null | undefined): string => (v ?? "").trim().toLowerCase();

const loadAccounts = async (orgId: string): Promise<AccountRow[]> => {
  const res = await query(
    `SELECT id, lower(google_account_email) AS email, scopes
       FROM google_oauth_tokens WHERE org_id = $1 AND disconnected_at IS NULL ORDER BY created_at ASC`,
    [orgId]
  );
  return res.rows.map((r) => ({ id: r.id as string, email: r.email as string, scopes: (r.scopes as string) ?? "" }));
};

// Per-mailbox owner addresses: the account email + senders of its SENT mail.
const loadOwnerAddressesByAccount = async (
  orgId: string,
  accounts: AccountRow[]
): Promise<Map<string, Set<string>>> => {
  const byAccount = new Map<string, Set<string>>();
  for (const a of accounts) byAccount.set(a.id, new Set([a.email]));
  const aliases = await query(
    `SELECT DISTINCT google_account_id, lower(from_email) AS email
       FROM gmail_messages_silver
      WHERE org_id = $1 AND labels ? 'SENT' AND from_email IS NOT NULL AND from_email <> ''`,
    [orgId]
  );
  for (const r of aliases.rows) {
    const set = byAccount.get(r.google_account_id as string);
    const e = lc(r.email as string);
    if (set && e) set.add(e);
  }
  return byAccount;
};

const hasSendScope = (scopes: string): boolean => scopes.split(/\s+/).includes(GMAIL_SEND_SCOPE);

/**
 * Newest-first messages of the person's threads -> per thread, the owner
 * address to answer from: the sender of the newest message that is ours, or the
 * owner address the person wrote to on their newest message. Third-party
 * messages carry no answer. Null = no owner address took part.
 */
export const answeringAddress = (
  newestFirst: Pick<ThreadMessageRow, "from_email" | "to_emails" | "cc_emails">[],
  person: string,
  owner: Set<string>
): string | null => {
  for (const m of newestFirst) {
    const from = lc(m.from_email);
    if (owner.has(from)) return from;
    if (from === person) {
      const recipients = [...(m.to_emails ?? []), ...(m.cc_emails ?? [])].map(lc);
      const ours = recipients.find((r) => owner.has(r));
      if (ours) return ours;
    }
  }
  return null;
};

interface ThreadCandidate {
  thread: LatestThread;
  latestMessageId: string;
}

const findThreads = async (
  orgId: string,
  person: string,
  onlyThreadId?: string
): Promise<{ connected: boolean; candidates: ThreadCandidate[] }> => {
  const accounts = await loadAccounts(orgId);
  if (accounts.length === 0) return { connected: false, candidates: [] };

  // Threads the person appears in (index-carried, same match as the
  // conversation read), then every message of those threads, newest first.
  const rows = await query(
    `WITH matched AS (
       SELECT DISTINCT google_account_id, thread_id
         FROM gmail_messages_silver
        WHERE org_id = $1
          AND thread_id IS NOT NULL
          AND (lower(from_email) = $2 OR to_emails ? $2 OR cc_emails ? $2)
          AND ($3::text IS NULL OR thread_id = $3::text)
     )
     SELECT s.google_account_id, s.thread_id, s.gmail_message_id, s.from_email,
            s.to_emails, s.cc_emails, s.subject, s.sent_at, s.labels
       FROM gmail_messages_silver s
       JOIN matched m ON m.google_account_id = s.google_account_id AND m.thread_id = s.thread_id
      WHERE s.org_id = $1
        AND NOT (s.labels ?| $4::text[])
      ORDER BY s.sent_at DESC NULLS LAST, s.gmail_message_id DESC
      LIMIT $5`,
    [orgId, person, onlyThreadId ?? null, EXCLUDED_LABELS, MESSAGE_SCAN_LIMIT]
  );
  const messages = rows.rows as unknown as ThreadMessageRow[];
  if (messages.length === 0) return { connected: true, candidates: [] };

  const owners = await loadOwnerAddressesByAccount(orgId, accounts);
  const accountById = new Map(accounts.map((a) => [a.id, a]));

  // Group per (mailbox, thread), keeping newest-first order (threads ordered by
  // their newest message, since rows arrive newest first).
  const groups = new Map<string, ThreadMessageRow[]>();
  for (const m of messages) {
    const key = `${m.google_account_id}:${m.thread_id}`;
    const list = groups.get(key) ?? [];
    list.push(m);
    groups.set(key, list);
  }

  const candidates: ThreadCandidate[] = [];
  for (const list of groups.values()) {
    const latest = list[0];
    const account = accountById.get(latest.google_account_id);
    const owner = owners.get(latest.google_account_id);
    if (!account || !owner) continue;
    const fromAddress = answeringAddress(list, person, owner);
    if (!fromAddress) continue;
    const latestFrom = lc(latest.from_email);
    candidates.push({
      latestMessageId: latest.gmail_message_id,
      thread: {
        threadId: latest.thread_id,
        googleAccountId: account.id,
        mailbox: account.email,
        fromAddress,
        lastMessageAt: latest.sent_at instanceof Date ? latest.sent_at.toISOString() : null,
        lastMessageDirection: latestFrom === person ? "inbound" : owner.has(latestFrom) ? "outbound" : "other",
        subject: latest.subject ?? list.find((m) => m.subject)?.subject ?? null,
        sendPermission: hasSendScope(account.scopes),
      },
    });
  }
  return { connected: true, candidates };
};

export const findLatestThread = async (orgId: string, addressRaw: string): Promise<LatestThreadResult> => {
  const person = lc(addressRaw);
  const { connected, candidates } = await findThreads(orgId, person);
  if (!connected) return { found: false, reason: "no_google_account_connected" };
  const first = candidates[0];
  if (!first) return { found: false, reason: "no_messages" };
  return { found: true, thread: first.thread };
};

// ─── The reply ───

export type ReplyRefusalCode =
  | "no_google_account_connected"
  | "thread_not_found"
  | "google_send_permission_missing"
  | "from_address_not_send_as";

export class ReplyRefusal extends Error {
  constructor(
    readonly status: number,
    readonly code: ReplyRefusalCode,
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "ReplyRefusal";
  }
}

export const sendPermissionMissing = (mailbox: string): ReplyRefusal =>
  new ReplyRefusal(
    403,
    "google_send_permission_missing",
    `The Google account ${mailbox} was connected without permission to send email. ` +
      `The org owner must reconnect Google (dashboard, CRM, Google) and grant send access. Nothing was sent.`,
    { mailbox }
  );

export interface ReplyInput {
  to: string;
  threadId: string;
  bodyHtml: string;
  bodyText?: string;
}

export interface ReplyResult {
  sent: true;
  gmailMessageId: string;
  threadId: string;
  mailbox: string;
  from: string;
  to: string;
  subject: string;
  inReplyTo: string | null;
  recorded: boolean;
}

export const replySubject = (subject: string | null): string => {
  const base = (subject ?? "").replace(/^\s*((re|fwd?|aw|tr)\s*:\s*)+/i, "").trim();
  return `Re: ${base}`.trim();
};

// RFC 2047 encoded-word when the header is not plain ASCII.
const encodeHeader = (v: string): string =>
  /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, "utf-8").toString("base64")}?=`;

// Plain-text alternative of the reply. A paragraph end is a BLANK line (what
// every mail client shows between <p>s); a <br> or a div/li end stays a single
// line break (GMAIL-PARAGRAPHS-1021: paragraphs were glued in text views).
export const htmlToText = (html: string): string =>
  html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|h[1-6])>/gi, "\n\n")
    .replace(/<\/(div|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const wrap76 = (b64: string): string => b64.replace(/.{1,76}/g, (l) => `${l}\r\n`).trimEnd();

export const buildRawReply = (p: {
  from: string;
  to: string;
  subject: string;
  inReplyTo: string | null;
  references: string[];
  bodyHtml: string;
  bodyText: string;
  boundary?: string;
}): string => {
  const boundary = p.boundary ?? `b_${crypto.randomBytes(12).toString("hex")}`;
  const headers = [
    `From: ${p.from}`,
    `To: ${p.to}`,
    `Subject: ${encodeHeader(p.subject)}`,
    ...(p.inReplyTo ? [`In-Reply-To: ${p.inReplyTo}`] : []),
    ...(p.references.length > 0 ? [`References: ${p.references.join(" ")}`] : []),
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const part = (type: string, content: string) =>
    [
      `--${boundary}`,
      `Content-Type: ${type}; charset="UTF-8"`,
      "Content-Transfer-Encoding: base64",
      "",
      wrap76(Buffer.from(content, "utf-8").toString("base64")),
    ].join("\r\n");
  const mime = [
    headers.join("\r\n"),
    "",
    part("text/plain", p.bodyText),
    part("text/html", p.bodyHtml),
    `--${boundary}--`,
    "",
  ].join("\r\n");
  return Buffer.from(mime, "utf-8").toString("base64url");
};

const headerOf = (message: GmailMessage | null, name: string): string | null => {
  const payload = (message?.payload as { headers?: { name?: string; value?: string }[] } | undefined) ?? {};
  const found = (payload.headers ?? []).find((h) => (h.name ?? "").toLowerCase() === name.toLowerCase());
  const v = found?.value?.trim();
  return v ? v : null;
};

export const replyInThread = async (
  orgId: string,
  input: ReplyInput,
  caller: CallerContext,
  runId?: string,
  featureSlug?: string,
  brandId?: string
): Promise<ReplyResult> => {
  const person = lc(input.to);
  const { connected, candidates } = await findThreads(orgId, person, input.threadId);
  if (!connected) {
    throw new ReplyRefusal(404, "no_google_account_connected", "No Google account is connected for this org. Nothing was sent.");
  }
  const target = candidates[0];
  if (!target) {
    throw new ReplyRefusal(
      404,
      "thread_not_found",
      `No Gmail thread ${input.threadId} with ${person} that a connected mailbox can answer. Nothing was sent.`,
      { threadId: input.threadId }
    );
  }
  const { thread } = target;
  if (!thread.sendPermission) throw sendPermissionMissing(thread.mailbox);

  const account = await getGoogleAccountById(orgId, thread.googleAccountId);
  if (!account) {
    throw new ReplyRefusal(404, "no_google_account_connected", `The mailbox ${thread.mailbox} is no longer connected. Nothing was sent.`);
  }
  const provider = createAccessTokenProvider(account, caller, runId, featureSlug, brandId);

  // The address must still be one Gmail lets this mailbox send as: otherwise
  // Gmail would silently rewrite From to the primary address.
  const sendAs = await withTokenRetry(provider, (t) => listGmailSendAs(t));
  const allowed = sendAs.filter(
    (s) => s.isPrimary === true || s.verificationStatus === undefined || s.verificationStatus === "accepted"
  );
  if (!allowed.some((s) => lc(s.sendAsEmail) === thread.fromAddress)) {
    throw new ReplyRefusal(
      422,
      "from_address_not_send_as",
      `${thread.mailbox} cannot send as ${thread.fromAddress} (not one of its Gmail send-as addresses). Nothing was sent.`,
      { mailbox: thread.mailbox, from: thread.fromAddress }
    );
  }

  // Threading headers come from the newest message of the thread.
  const latest = await query(
    `SELECT payload FROM gmail_messages_raw WHERE org_id = $1 AND gmail_message_id = $2`,
    [orgId, target.latestMessageId]
  );
  const latestPayload = (latest.rows[0]?.payload as GmailMessage | undefined) ?? null;
  const messageId = parseMessageIdList(headerOf(latestPayload, "Message-ID"))[0] ?? null;
  const priorRefs = parseMessageIdList(headerOf(latestPayload, "References"));
  const references = messageId && !priorRefs.includes(messageId) ? [...priorRefs, messageId] : priorRefs;
  const subject = replySubject(thread.subject ?? headerOf(latestPayload, "Subject"));

  const raw = buildRawReply({
    from: thread.fromAddress,
    to: person,
    subject,
    inReplyTo: messageId,
    references,
    bodyHtml: input.bodyHtml,
    bodyText: input.bodyText && input.bodyText.trim() ? input.bodyText : htmlToText(input.bodyHtml),
  });

  let sent;
  try {
    sent = await withTokenRetry(provider, (t) => sendGmailMessage(t, { raw, threadId: thread.threadId }));
  } catch (err) {
    if (isInsufficientScopeError(err)) throw sendPermissionMissing(thread.mailbox);
    throw err;
  }

  // Recorded like any send: the sent message enters the mirror now (the
  // 15-minute delta would also see it). The email already left, so a failed
  // write is logged, never turned into an error the caller would retry.
  let recorded = false;
  try {
    const full = await withTokenRetry(provider, (t) => getGmailMessage(t, sent.id));
    await upsertMessage(orgId, account.id, {
      id: full.id,
      threadId: full.threadId,
      historyId: full.historyId,
      payload: full,
    });
    recorded = true;
  } catch (err) {
    const detail = err instanceof GoogleApiError ? `${err.status}` : (err as Error).message;
    console.error(
      `[google-service] thread-reply: sent ${sent.id} in thread ${sent.threadId} but mirror record FAILED: ${detail}`
    );
  }

  return {
    sent: true,
    gmailMessageId: sent.id,
    threadId: sent.threadId,
    mailbox: thread.mailbox,
    from: thread.fromAddress,
    to: person,
    subject,
    inReplyTo: messageId,
    recorded,
  };
};
