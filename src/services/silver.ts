import { query } from "../db/client";
import type { GmailMessage, PersonResource } from "./google-api";

// ─── Contact silver (parsed from a People PersonResource payload) ───

export interface ContactSilver {
  displayName: string | null;
  primaryEmail: string | null;
  emails: string[];
  phones: string[];
  organization: string | null;
  jobTitle: string | null;
  photoUrl: string | null;
  updatedAt: string | null; // ISO
  deleted: boolean;
}

type AnyRecord = Record<string, unknown>;

const asArray = (v: unknown): AnyRecord[] =>
  Array.isArray(v) ? (v as AnyRecord[]) : [];

const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

export const parseContactSilver = (person: PersonResource): ContactSilver => {
  const names = asArray(person.names);
  const displayName = str(names[0]?.displayName);

  const emailAddresses = asArray(person.emailAddresses);
  const emails = emailAddresses
    .map((e) => str(e?.value))
    .filter((v): v is string => v !== null);
  const primary = emailAddresses.find(
    (e) => (e?.metadata as AnyRecord | undefined)?.primary === true
  );
  const primaryEmail = str(primary?.value) ?? emails[0] ?? null;

  const phones = asArray(person.phoneNumbers)
    .map((p) => str(p?.value))
    .filter((v): v is string => v !== null);

  const organizations = asArray(person.organizations);
  const organization = str(organizations[0]?.name);
  const jobTitle = str(organizations[0]?.title);

  const photos = asArray(person.photos);
  const primaryPhoto = photos.find(
    (p) => (p?.metadata as AnyRecord | undefined)?.primary === true
  );
  const photoUrl = str(primaryPhoto?.url) ?? str(photos[0]?.url);

  const meta = (person.metadata as AnyRecord | undefined) ?? {};
  const sources = asArray(meta.sources);
  const updateTimes = sources
    .map((s) => str(s?.updateTime))
    .filter((v): v is string => v !== null)
    .sort();
  const updatedAt = updateTimes.length > 0 ? updateTimes[updateTimes.length - 1] : null;
  const deleted = meta.deleted === true;

  return {
    displayName,
    primaryEmail,
    emails,
    phones,
    organization,
    jobTitle,
    photoUrl,
    updatedAt,
    deleted,
  };
};

// ─── Message silver (parsed from a Gmail messages.get format=full payload) ───

export interface MessageSilver {
  fromEmail: string | null;
  fromName: string | null;
  to: string[];
  cc: string[];
  subject: string | null;
  snippet: string | null;
  sentAt: string | null; // ISO
  labels: string[];
  historyId: string | null;
}

interface ParsedAddress {
  name: string | null;
  email: string | null;
}

// Parse a single RFC 5322 address, e.g. `"Ada Lovelace" <ada@x.com>` or `ada@x.com`.
const parseAddress = (raw: string | null): ParsedAddress => {
  if (!raw) return { name: null, email: null };
  const m = raw.match(/^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/);
  if (m) {
    const name = m[1]?.trim();
    return { name: name && name.length > 0 ? name : null, email: m[2].trim().toLowerCase() };
  }
  const trimmed = raw.trim();
  if (trimmed.includes("@")) return { name: null, email: trimmed.toLowerCase() };
  return { name: trimmed.length > 0 ? trimmed : null, email: null };
};

// Split a To/Cc header on top-level commas and return the parsed email addresses.
const parseAddressList = (raw: string | null): string[] => {
  if (!raw) return [];
  return raw
    .split(",")
    .map((part) => parseAddress(part).email)
    .filter((v): v is string => v !== null);
};

export const parseMessageSilver = (message: GmailMessage): MessageSilver => {
  const payload = (message.payload as AnyRecord | undefined) ?? {};
  const headers = asArray(payload.headers);
  const getHeader = (name: string): string | null => {
    const found = headers.find(
      (h) => typeof h?.name === "string" && (h.name as string).toLowerCase() === name.toLowerCase()
    );
    return str(found?.value);
  };

  const from = parseAddress(getHeader("From"));
  const to = parseAddressList(getHeader("To"));
  const cc = parseAddressList(getHeader("Cc"));
  const subject = getHeader("Subject");
  const snippet = str(message.snippet);

  let sentAt: string | null = null;
  if (message.internalDate && /^\d+$/.test(message.internalDate)) {
    sentAt = new Date(Number(message.internalDate)).toISOString();
  } else {
    const dateHeader = getHeader("Date");
    if (dateHeader) {
      const d = new Date(dateHeader);
      if (!Number.isNaN(d.getTime())) sentAt = d.toISOString();
    }
  }

  const labels = Array.isArray(message.labelIds)
    ? message.labelIds.filter((l): l is string => typeof l === "string")
    : [];

  return {
    fromEmail: from.email,
    fromName: from.name,
    to,
    cc,
    subject,
    snippet,
    sentAt,
    labels,
    historyId: str(message.historyId),
  };
};

// ─── Silver writers (upsert keyed on the bronze natural key) ───

export const upsertContactSilver = async (
  orgId: string,
  googleAccountId: string,
  sourceRowId: string,
  resourceName: string,
  etag: string | null,
  s: ContactSilver
): Promise<void> => {
  await query(
    `INSERT INTO google_contacts_silver
        (org_id, google_account_id, resource_name, etag, display_name, primary_email,
         emails, phones, organization, job_title, photo_url, updated_at, deleted,
         source_row_id, last_rebuilt_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12, $13, $14, NOW())
     ON CONFLICT (org_id, resource_name) DO UPDATE SET
        google_account_id = EXCLUDED.google_account_id,
        etag = EXCLUDED.etag,
        display_name = EXCLUDED.display_name,
        primary_email = EXCLUDED.primary_email,
        emails = EXCLUDED.emails,
        phones = EXCLUDED.phones,
        organization = EXCLUDED.organization,
        job_title = EXCLUDED.job_title,
        photo_url = EXCLUDED.photo_url,
        updated_at = EXCLUDED.updated_at,
        deleted = EXCLUDED.deleted,
        source_row_id = EXCLUDED.source_row_id,
        last_rebuilt_at = NOW()`,
    [
      orgId,
      googleAccountId,
      resourceName,
      etag,
      s.displayName,
      s.primaryEmail,
      JSON.stringify(s.emails),
      JSON.stringify(s.phones),
      s.organization,
      s.jobTitle,
      s.photoUrl,
      s.updatedAt,
      s.deleted,
      sourceRowId,
    ]
  );
};

export const deleteContactSilver = async (
  orgId: string,
  resourceName: string
): Promise<void> => {
  await query(
    `DELETE FROM google_contacts_silver WHERE org_id = $1 AND resource_name = $2`,
    [orgId, resourceName]
  );
};

export const upsertMessageSilver = async (
  orgId: string,
  googleAccountId: string,
  sourceRowId: string,
  gmailMessageId: string,
  threadId: string,
  s: MessageSilver
): Promise<void> => {
  await query(
    `INSERT INTO gmail_messages_silver
        (org_id, google_account_id, gmail_message_id, thread_id, from_email, from_name,
         to_emails, cc_emails, subject, snippet, sent_at, labels, history_id, source_row_id, last_rebuilt_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12::jsonb, $13, $14, NOW())
     ON CONFLICT (org_id, gmail_message_id) DO UPDATE SET
        google_account_id = EXCLUDED.google_account_id,
        thread_id = EXCLUDED.thread_id,
        from_email = EXCLUDED.from_email,
        from_name = EXCLUDED.from_name,
        to_emails = EXCLUDED.to_emails,
        cc_emails = EXCLUDED.cc_emails,
        subject = EXCLUDED.subject,
        snippet = EXCLUDED.snippet,
        sent_at = EXCLUDED.sent_at,
        labels = EXCLUDED.labels,
        history_id = EXCLUDED.history_id,
        source_row_id = EXCLUDED.source_row_id,
        last_rebuilt_at = NOW()`,
    [
      orgId,
      googleAccountId,
      gmailMessageId,
      threadId,
      s.fromEmail,
      s.fromName,
      JSON.stringify(s.to),
      JSON.stringify(s.cc),
      s.subject,
      s.snippet,
      s.sentAt,
      JSON.stringify(s.labels),
      s.historyId,
      sourceRowId,
    ]
  );
};
