import { query } from "../db/client";
import type { GmailMessage, PersonResource } from "./google-api";
import {
  parseContactSilver,
  parseMessageSilver,
  upsertContactSilver,
  upsertMessageSilver,
} from "./silver";

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";
const BATCH = 500;

// Idempotent backfill of the silver tables from existing bronze rows. Keyset
// paginated by id so it survives large tables and re-runs safely (upserts). Run
// AFTER app.listen() (never in the boot window) with .catch(console.error).
export const backfillSilver = async (): Promise<{ contacts: number; messages: number }> => {
  const contacts = await backfillContacts();
  const messages = await backfillMessages();
  console.log(
    `[google-service] silver backfill complete: contacts=${contacts} messages=${messages}`
  );
  return { contacts, messages };
};

const backfillContacts = async (): Promise<number> => {
  let lastId = ZERO_UUID;
  let total = 0;
  for (;;) {
    const res = await query(
      `SELECT id, org_id, google_account_id, resource_name, etag, payload
         FROM google_contacts_raw
         WHERE id > $1
         ORDER BY id
         LIMIT ${BATCH}`,
      [lastId]
    );
    if (res.rows.length === 0) break;
    for (const row of res.rows) {
      await upsertContactSilver(
        row.org_id as string,
        row.google_account_id as string,
        row.id as string,
        row.resource_name as string,
        (row.etag as string | null) ?? null,
        parseContactSilver(row.payload as PersonResource)
      );
      total += 1;
    }
    lastId = res.rows[res.rows.length - 1].id as string;
  }
  return total;
};

const backfillMessages = async (): Promise<number> => {
  let lastId = ZERO_UUID;
  let total = 0;
  for (;;) {
    const res = await query(
      `SELECT id, org_id, google_account_id, gmail_message_id, thread_id, payload
         FROM gmail_messages_raw
         WHERE id > $1
         ORDER BY id
         LIMIT ${BATCH}`,
      [lastId]
    );
    if (res.rows.length === 0) break;
    for (const row of res.rows) {
      await upsertMessageSilver(
        row.org_id as string,
        row.google_account_id as string,
        row.id as string,
        row.gmail_message_id as string,
        row.thread_id as string,
        parseMessageSilver(row.payload as GmailMessage)
      );
      total += 1;
    }
    lastId = res.rows[res.rows.length - 1].id as string;
  }
  return total;
};
