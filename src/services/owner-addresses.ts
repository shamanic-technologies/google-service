import { query } from "../db/client";

// Which addresses are "us" for an org's mailbox — the ONE definition every read
// that labels a message ours vs theirs uses (correspondents, conversation).
//
// Owner addresses = every connected Google account email of the org, plus every
// sender of a message Gmail labelled SENT in this org's mirror (send-as aliases
// such as a work address relayed through the personal mailbox). Gmail puts SENT
// only on mail that left this mailbox, so it is the mailbox's own statement of
// which addresses are its own.
//
// Two reads deciding this separately is how the owner's reply from an alias came
// back "outbound" in the correspondents count and "other" in the conversation.

export type OwnerAddressesResult =
  | { connected: true; addresses: string[] }
  | { connected: false };

export const resolveOwnerAddresses = async (orgId: string): Promise<OwnerAddressesResult> => {
  const accounts = await query(
    `SELECT lower(google_account_email) AS email FROM google_oauth_tokens WHERE org_id = $1`,
    [orgId]
  );
  if (accounts.rows.length === 0) return { connected: false };

  // Send-as aliases, read off the partial index on SENT-labelled messages.
  const aliases = await query(
    `SELECT DISTINCT lower(from_email) AS email
       FROM gmail_messages_silver
      WHERE org_id = $1 AND labels ? 'SENT' AND from_email IS NOT NULL AND from_email <> ''`,
    [orgId]
  );

  const owner = new Set<string>();
  for (const r of [...accounts.rows, ...aliases.rows]) {
    const e = ((r.email as string | null) ?? "").trim();
    if (e.length > 0) owner.add(e);
  }
  return { connected: true, addresses: [...owner].sort() };
};
