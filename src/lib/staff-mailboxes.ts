/**
 * The addresses our STAFF use, and therefore the mailboxes that hold the agency's own side of a
 * client's conversations. distribute.you operates its clients' brands as an agency: a staff
 * member answering a prospect by hand does it from their own Gmail, and that exchange belongs in
 * the client's lead history (`GET /internal/staff-mailboxes/conversation`).
 *
 * Hardcoded on purpose, like every other copy of the staff set in the fleet (the dashboard and
 * admin allowlists, api-service `STAFF_EMAILS`): keep it byte-equal with those. A mailbox whose
 * Google account is NOT listed here is never read across orgs, whoever connected it.
 */
export const STAFF_ADDRESSES: readonly string[] = ["kevin.lourd@gmail.com", "kevin@distribute.you"];

