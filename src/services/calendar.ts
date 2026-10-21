// Google Calendar connection (GOOGLE-CALENDAR-INTEGRATION-1021).
//
// Why: a client often books meetings through his own scheduling link (neocal,
// Calendly, by hand), outside our own AI booking, so nothing told us a meeting
// was booked, nor whether it was held. Any client connects his Google Calendar
// from the dashboard Integrations page (its own consent, never bundled into the
// Gmail one); we mirror his primary calendar and serve the events as facts.
//
// Two facts, two sources:
//   - booked: an event on the calendar, whatever tool created it. Served with
//     its attendees; WHICH attendee is which lead is the consumer's judgment
//     (an address is not a person: people book from another address).
//   - attended: ONLY the participant list of the Google Meet call (Meet REST
//     API conference records). A passed, not-cancelled event proves nothing,
//     so an event without a Meet record stays unknown (owner 2026-10-21: "A
//     pour now, pour rester simple").
import { query } from "../db/client";
import { getGoogleOAuthClient, type CallerContext } from "./key-service";
import {
  CALENDAR_EVENTS_SCOPE,
  MEET_READ_SCOPE,
  refreshAccessToken,
} from "./google-oauth";
import type { AccessTokenProvider } from "./google-tokens";
import { apiFetch, GoogleApiError, withTokenRetry } from "./google-api";

const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const MEET_BASE = "https://meet.googleapis.com/v2";
const ACCESS_TOKEN_LEEWAY_MS = 60_000;

// Window mirrored on every pass: a booking made a month ago for a meeting in
// two months is inside it; Google re-sends every event of the window, and only
// those whose etag moved are written.
export const CALENDAR_LOOKBACK_DAYS = 30;
export const CALENDAR_LOOKAHEAD_DAYS = 180;
// Meet publishes the conference record when the call ends, sometimes minutes
// later. An event is re-checked on every pass until a record shows up or this
// long after its end, then "no_record" is final.
export const MEET_CHECK_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface CalendarAccount {
  id: string;
  orgId: string;
  userId: string;
  googleAccountEmail: string;
  refreshToken: string;
  accessToken: string | null;
  accessTokenExpiresAt: Date | null;
  scopes: string;
}

const ACCOUNT_COLUMNS = `id, org_id, user_id, google_account_email, refresh_token,
  access_token, access_token_expires_at, scopes`;

const rowToAccount = (row: Record<string, unknown>): CalendarAccount => ({
  id: row.id as string,
  orgId: row.org_id as string,
  userId: row.user_id as string,
  googleAccountEmail: row.google_account_email as string,
  refreshToken: row.refresh_token as string,
  accessToken: (row.access_token as string | null) ?? null,
  accessTokenExpiresAt: (row.access_token_expires_at as Date | null) ?? null,
  scopes: row.scopes as string,
});

export const hasScope = (scopes: string, scope: string): boolean =>
  scopes.split(/\s+/).includes(scope);

export const upsertCalendarAccount = async (params: {
  orgId: string;
  userId: string;
  googleAccountEmail: string;
  refreshToken: string;
  accessToken: string;
  accessTokenExpiresAt: Date;
  scopes: string;
}): Promise<CalendarAccount> => {
  const result = await query(
    `INSERT INTO google_calendar_accounts
        (org_id, user_id, google_account_email, refresh_token, access_token,
         access_token_expires_at, scopes)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (org_id, google_account_email) DO UPDATE SET
        user_id = EXCLUDED.user_id,
        refresh_token = EXCLUDED.refresh_token,
        access_token = EXCLUDED.access_token,
        access_token_expires_at = EXCLUDED.access_token_expires_at,
        scopes = EXCLUDED.scopes,
        last_sync_error = NULL,
        updated_at = NOW()
     RETURNING ${ACCOUNT_COLUMNS}`,
    [
      params.orgId,
      params.userId,
      params.googleAccountEmail,
      params.refreshToken,
      params.accessToken,
      params.accessTokenExpiresAt,
      params.scopes,
    ]
  );
  return rowToAccount(result.rows[0]);
};

export const listAllCalendarAccounts = async (): Promise<CalendarAccount[]> => {
  const result = await query(
    `SELECT ${ACCOUNT_COLUMNS} FROM google_calendar_accounts ORDER BY created_at ASC`
  );
  return result.rows.map(rowToAccount);
};

export interface CalendarAccountView {
  email: string;
  status: "active" | "sync_failing";
  attendance: "meet" | "meet_permission_missing";
  connectedAt: string;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
}

export const listOrgCalendarAccounts = async (orgId: string): Promise<CalendarAccountView[]> => {
  const result = await query(
    `SELECT google_account_email, scopes, created_at, last_synced_at, last_sync_error
       FROM google_calendar_accounts
      WHERE org_id = $1
      ORDER BY created_at ASC`,
    [orgId]
  );
  return result.rows.map((row) => ({
    email: row.google_account_email as string,
    status: row.last_sync_error ? ("sync_failing" as const) : ("active" as const),
    attendance: hasScope(row.scopes as string, MEET_READ_SCOPE)
      ? ("meet" as const)
      : ("meet_permission_missing" as const),
    connectedAt: (row.created_at as Date).toISOString(),
    lastSyncedAt: row.last_synced_at ? (row.last_synced_at as Date).toISOString() : null,
    lastSyncError: (row.last_sync_error as string | null) ?? null,
  }));
};

const createCalendarTokenProvider = (
  account: CalendarAccount,
  caller: CallerContext
): AccessTokenProvider => {
  let current = account.accessToken;
  let expiresAt = account.accessTokenExpiresAt;
  const refresh = async (): Promise<string> => {
    const oauth = await getGoogleOAuthClient(caller);
    const refreshed = await refreshAccessToken({
      clientId: oauth.clientId,
      clientSecret: oauth.clientSecret,
      refreshToken: account.refreshToken,
    });
    const exp = new Date(Date.now() + refreshed.expires_in * 1000);
    await query(
      `UPDATE google_calendar_accounts
          SET access_token = $2, access_token_expires_at = $3, updated_at = NOW()
        WHERE id = $1`,
      [account.id, refreshed.access_token, exp]
    );
    current = refreshed.access_token;
    expiresAt = exp;
    return refreshed.access_token;
  };
  return {
    async get() {
      if (current && expiresAt && expiresAt.getTime() - Date.now() > ACCESS_TOKEN_LEEWAY_MS) {
        return current;
      }
      return refresh();
    },
    forceRefresh: refresh,
  };
};

// ─── Google payload → typed fields ───

interface GoogleEventTime {
  dateTime?: string;
  date?: string;
}

interface GoogleCalendarEvent {
  id: string;
  etag: string;
  status?: string;
  summary?: string;
  start?: GoogleEventTime;
  end?: GoogleEventTime;
  created?: string;
  updated?: string;
  organizer?: { email?: string };
  attendees?: {
    email?: string;
    displayName?: string;
    responseStatus?: string;
    organizer?: boolean;
    self?: boolean;
    optional?: boolean;
  }[];
  conferenceData?: {
    conferenceId?: string;
    conferenceSolution?: { key?: { type?: string } };
  };
}

export interface EventAttendee {
  email: string;
  displayName: string | null;
  responseStatus: string | null;
  organizer: boolean;
  self: boolean;
}

export interface ParsedEvent {
  status: string;
  summary: string | null;
  startAt: Date | null;
  endAt: Date | null;
  googleCreatedAt: Date | null;
  googleUpdatedAt: Date | null;
  organizerEmail: string | null;
  attendees: EventAttendee[];
  meetCode: string | null;
}

// An all-day event carries a date, not a time: read it as midnight UTC.
const toDate = (t?: GoogleEventTime): Date | null => {
  const raw = t?.dateTime ?? (t?.date ? `${t.date}T00:00:00Z` : undefined);
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
};

const toTimestamp = (raw?: string): Date | null => {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
};

export const parseCalendarEvent = (ev: GoogleCalendarEvent): ParsedEvent => {
  const isMeet = ev.conferenceData?.conferenceSolution?.key?.type === "hangoutsMeet";
  return {
    status: ev.status ?? "confirmed",
    summary: ev.summary ?? null,
    startAt: toDate(ev.start),
    endAt: toDate(ev.end),
    googleCreatedAt: toTimestamp(ev.created),
    googleUpdatedAt: toTimestamp(ev.updated),
    organizerEmail: ev.organizer?.email?.toLowerCase() ?? null,
    attendees: (ev.attendees ?? [])
      .filter((a) => typeof a.email === "string" && a.email.length > 0)
      .map((a) => ({
        email: (a.email as string).toLowerCase(),
        displayName: a.displayName ?? null,
        responseStatus: a.responseStatus ?? null,
        organizer: a.organizer === true,
        self: a.self === true,
      })),
    meetCode: isMeet && ev.conferenceData?.conferenceId ? ev.conferenceData.conferenceId : null,
  };
};

// Writes one event. A row whose etag did not move is left untouched, so a pass
// over an unchanged calendar writes nothing and the changes feed stays quiet.
// A Meet event starts its attendance check as "pending"; an event that stopped
// being a Meet call (or became one) resets it.
export const upsertCalendarEvent = async (
  account: CalendarAccount,
  ev: GoogleCalendarEvent
): Promise<"inserted" | "updated" | "unchanged"> => {
  const p = parseCalendarEvent(ev);
  const result = await query(
    `INSERT INTO google_calendar_events
        (org_id, calendar_account_id, google_event_id, etag, payload, status, summary,
         start_at, end_at, google_created_at, google_updated_at, organizer_email,
         attendees, meet_code, meet_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
             CASE WHEN $14::text IS NULL THEN 'not_meet' ELSE 'pending' END)
     ON CONFLICT (calendar_account_id, google_event_id) DO UPDATE SET
        etag = EXCLUDED.etag,
        payload = EXCLUDED.payload,
        status = EXCLUDED.status,
        summary = EXCLUDED.summary,
        start_at = EXCLUDED.start_at,
        end_at = EXCLUDED.end_at,
        google_created_at = EXCLUDED.google_created_at,
        google_updated_at = EXCLUDED.google_updated_at,
        organizer_email = EXCLUDED.organizer_email,
        attendees = EXCLUDED.attendees,
        meet_code = EXCLUDED.meet_code,
        meet_status = CASE
          WHEN google_calendar_events.meet_code IS NOT DISTINCT FROM EXCLUDED.meet_code
               AND google_calendar_events.end_at IS NOT DISTINCT FROM EXCLUDED.end_at
          THEN google_calendar_events.meet_status
          ELSE EXCLUDED.meet_status END,
        meet_participants = CASE
          WHEN google_calendar_events.meet_code IS NOT DISTINCT FROM EXCLUDED.meet_code
               AND google_calendar_events.end_at IS NOT DISTINCT FROM EXCLUDED.end_at
          THEN google_calendar_events.meet_participants
          ELSE '[]'::jsonb END,
        meet_checked_at = CASE
          WHEN google_calendar_events.meet_code IS NOT DISTINCT FROM EXCLUDED.meet_code
               AND google_calendar_events.end_at IS NOT DISTINCT FROM EXCLUDED.end_at
          THEN google_calendar_events.meet_checked_at
          ELSE NULL END,
        fetched_at = NOW(),
        changed_at = NOW()
      WHERE google_calendar_events.etag IS DISTINCT FROM EXCLUDED.etag
     RETURNING (xmax = 0) AS inserted`,
    [
      account.orgId,
      account.id,
      ev.id,
      ev.etag,
      ev,
      p.status,
      p.summary,
      p.startAt,
      p.endAt,
      p.googleCreatedAt,
      p.googleUpdatedAt,
      p.organizerEmail,
      JSON.stringify(p.attendees),
      p.meetCode,
    ]
  );
  if (result.rows.length === 0) return "unchanged";
  return result.rows[0].inserted ? "inserted" : "updated";
};

// ─── Meet attendance ───

interface MeetParticipantRaw {
  earliestStartTime?: string;
  latestEndTime?: string;
  signedinUser?: { user?: string; displayName?: string };
  anonymousUser?: { displayName?: string };
  phoneUser?: { displayName?: string };
}

export interface MeetParticipant {
  displayName: string | null;
  kind: "signed_in" | "anonymous" | "phone";
  joinedAt: string | null;
  leftAt: string | null;
}

export const parseMeetParticipant = (p: MeetParticipantRaw): MeetParticipant => {
  const kind = p.signedinUser ? "signed_in" : p.phoneUser ? "phone" : "anonymous";
  const displayName =
    p.signedinUser?.displayName ?? p.anonymousUser?.displayName ?? p.phoneUser?.displayName ?? null;
  return {
    displayName,
    kind,
    joinedAt: p.earliestStartTime ?? null,
    leftAt: p.latestEndTime ?? null,
  };
};

const fetchMeetParticipants = async (
  provider: AccessTokenProvider,
  meetCode: string
): Promise<MeetParticipant[] | null> => {
  const filter = encodeURIComponent(`space.meeting_code = "${meetCode}"`);
  const records = await withTokenRetry(provider, (t) =>
    apiFetch<{ conferenceRecords?: { name: string }[] }>(
      `${MEET_BASE}/conferenceRecords?filter=${filter}`,
      t
    )
  );
  const list = records.conferenceRecords ?? [];
  if (list.length === 0) return null;
  const participants: MeetParticipant[] = [];
  for (const record of list) {
    let pageToken: string | undefined;
    do {
      const qs = new URLSearchParams({ pageSize: "100" });
      if (pageToken) qs.set("pageToken", pageToken);
      const page = await withTokenRetry(provider, (t) =>
        apiFetch<{ participants?: MeetParticipantRaw[]; nextPageToken?: string }>(
          `${MEET_BASE}/${record.name}/participants?${qs.toString()}`,
          t
        )
      );
      for (const p of page.participants ?? []) participants.push(parseMeetParticipant(p));
      pageToken = page.nextPageToken;
    } while (pageToken);
  }
  return participants;
};

const setMeetResult = async (
  eventRowId: string,
  status: "pending" | "record_found" | "no_record" | "unavailable",
  participants: MeetParticipant[],
  error: string | null,
  changed: boolean
): Promise<void> => {
  await query(
    `UPDATE google_calendar_events
        SET meet_status = $2, meet_participants = $3, meet_error = $4,
            meet_checked_at = NOW(),
            changed_at = CASE WHEN $5::boolean THEN NOW() ELSE changed_at END
      WHERE id = $1`,
    [eventRowId, status, JSON.stringify(participants), error, changed]
  );
};

// Reads the Meet participant list of every ended Meet event still "pending".
// Each event is isolated: one failure is stored on that event (never a fake
// "nobody came") and the rest go on.
export const checkMeetAttendance = async (
  account: CalendarAccount,
  provider: AccessTokenProvider,
  now: Date = new Date()
): Promise<{ checked: number; found: number }> => {
  const due = await query(
    `SELECT id, meet_code, end_at FROM google_calendar_events
      WHERE calendar_account_id = $1 AND meet_status = 'pending'
        AND status <> 'cancelled' AND end_at IS NOT NULL AND end_at <= $2
      ORDER BY end_at ASC`,
    [account.id, now]
  );
  let found = 0;
  const canReadMeet = hasScope(account.scopes, MEET_READ_SCOPE);
  for (const row of due.rows) {
    const id = row.id as string;
    if (!canReadMeet) {
      await setMeetResult(id, "unavailable", [], "meet_permission_missing", true);
      continue;
    }
    const expired = now.getTime() - (row.end_at as Date).getTime() > MEET_CHECK_WINDOW_MS;
    try {
      const participants = await fetchMeetParticipants(provider, row.meet_code as string);
      if (participants) {
        found++;
        await setMeetResult(id, "record_found", participants, null, true);
      } else if (expired) {
        await setMeetResult(id, "no_record", [], null, true);
      } else {
        await setMeetResult(id, "pending", [], null, false);
      }
    } catch (err) {
      // Google refusing the Meet read for this account (API not available to
      // it, permission withdrawn) will not change on retry: attendance unknown.
      if (err instanceof GoogleApiError && (err.status === 403 || err.status === 400)) {
        await setMeetResult(id, "unavailable", [], `${err.status} ${err.body}`.slice(0, 2000), true);
        continue;
      }
      console.error(
        `[google-service] calendar meet check failed org=${account.orgId} account=${account.id} event=${id}: ${(err as Error).message}`
      );
    }
  }
  return { checked: due.rows.length, found };
};

// ─── One pass over one calendar ───

export interface CalendarSyncSummary {
  inserted: number;
  updated: number;
  unchanged: number;
  meetChecked: number;
  meetFound: number;
}

export const syncCalendarAccount = async (
  account: CalendarAccount,
  caller: CallerContext,
  now: Date = new Date()
): Promise<CalendarSyncSummary> => {
  const provider = createCalendarTokenProvider(account, caller);
  const summary: CalendarSyncSummary = { inserted: 0, updated: 0, unchanged: 0, meetChecked: 0, meetFound: 0 };
  try {
    const timeMin = new Date(now.getTime() - CALENDAR_LOOKBACK_DAYS * 86_400_000).toISOString();
    const timeMax = new Date(now.getTime() + CALENDAR_LOOKAHEAD_DAYS * 86_400_000).toISOString();
    let pageToken: string | undefined;
    do {
      const qs = new URLSearchParams({
        timeMin,
        timeMax,
        singleEvents: "true",
        showDeleted: "true",
        maxResults: "250",
      });
      if (pageToken) qs.set("pageToken", pageToken);
      const page = await withTokenRetry(provider, (t) =>
        apiFetch<{ items?: GoogleCalendarEvent[]; nextPageToken?: string }>(
          `${CALENDAR_BASE}?${qs.toString()}`,
          t
        )
      );
      for (const ev of page.items ?? []) {
        summary[await upsertCalendarEvent(account, ev)]++;
      }
      pageToken = page.nextPageToken;
    } while (pageToken);

    const meet = await checkMeetAttendance(account, provider, now);
    summary.meetChecked = meet.checked;
    summary.meetFound = meet.found;

    await query(
      `UPDATE google_calendar_accounts
          SET last_synced_at = NOW(), last_sync_error = NULL, updated_at = NOW()
        WHERE id = $1`,
      [account.id]
    );
    return summary;
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    await query(
      `UPDATE google_calendar_accounts SET last_sync_error = $2, updated_at = NOW() WHERE id = $1`,
      [account.id, message.slice(0, 2000)]
    );
    throw err;
  }
};

// Background pass right after a connect: the calendar shows up without waiting
// for the next tick.
export const syncCalendarInBackground = (account: CalendarAccount, caller: CallerContext): void => {
  void syncCalendarAccount(account, caller).catch((err) =>
    console.error(
      `[google-service] calendar first sync failed org=${account.orgId} account=${account.id}: ${(err as Error).message}`
    )
  );
};

export const hasCalendarEventsScope = (scopes: string): boolean =>
  hasScope(scopes, CALENDAR_EVENTS_SCOPE);

// ─── Changes feed ───

export interface CalendarEventView {
  id: string;
  orgId: string;
  calendarEmail: string;
  googleEventId: string;
  status: string;
  title: string | null;
  startAt: string | null;
  endAt: string | null;
  bookedAt: string | null;
  updatedAt: string | null;
  organizerEmail: string | null;
  attendees: EventAttendee[];
  meet: {
    status: "not_meet" | "pending" | "record_found" | "no_record" | "unavailable";
    participants: MeetParticipant[];
    error: string | null;
    checkedAt: string | null;
  };
  changedAt: string;
}

export class CalendarCursorError extends Error {}

const encodeCursor = (changedAt: Date, id: string): string =>
  Buffer.from(JSON.stringify([changedAt.toISOString(), id])).toString("base64url");

const decodeCursor = (cursor: string): { changedAt: string; id: string } => {
  try {
    const [changedAt, id] = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as [string, string];
    if (typeof changedAt !== "string" || typeof id !== "string" || Number.isNaN(Date.parse(changedAt))) {
      throw new Error("bad shape");
    }
    return { changedAt, id };
  } catch {
    throw new CalendarCursorError("Invalid cursor");
  }
};

const iso = (v: unknown): string | null => (v ? (v as Date).toISOString() : null);

// Every event whose served fields changed after the cursor, oldest change first,
// across every org. A consumer keeps the last nextCursor and comes back with it;
// an event that changes again comes back again (its row moved forward).
export const listCalendarEventChanges = async (input: {
  cursor?: string;
  limit?: number;
}): Promise<{ events: CalendarEventView[]; nextCursor: string | null; hasMore: boolean }> => {
  const limit = input.limit ?? 200;
  const after = input.cursor ? decodeCursor(input.cursor) : null;
  const result = await query(
    `SELECT e.id, e.org_id, a.google_account_email, e.google_event_id, e.status, e.summary,
            e.start_at, e.end_at, e.google_created_at, e.google_updated_at, e.organizer_email,
            e.attendees, e.meet_status, e.meet_participants, e.meet_error, e.meet_checked_at,
            e.changed_at
       FROM google_calendar_events e
       JOIN google_calendar_accounts a ON a.id = e.calendar_account_id
      WHERE ($1::timestamptz IS NULL OR (e.changed_at, e.id) > ($1::timestamptz, $2::uuid))
      ORDER BY e.changed_at ASC, e.id ASC
      LIMIT $3`,
    [after?.changedAt ?? null, after?.id ?? null, limit + 1]
  );
  const rows = result.rows.slice(0, limit);
  const events = rows.map((r) => ({
    id: r.id as string,
    orgId: r.org_id as string,
    calendarEmail: r.google_account_email as string,
    googleEventId: r.google_event_id as string,
    status: r.status as string,
    title: (r.summary as string | null) ?? null,
    startAt: iso(r.start_at),
    endAt: iso(r.end_at),
    bookedAt: iso(r.google_created_at),
    updatedAt: iso(r.google_updated_at),
    organizerEmail: (r.organizer_email as string | null) ?? null,
    attendees: r.attendees as EventAttendee[],
    meet: {
      status: r.meet_status as CalendarEventView["meet"]["status"],
      participants: r.meet_participants as MeetParticipant[],
      error: (r.meet_error as string | null) ?? null,
      checkedAt: iso(r.meet_checked_at),
    },
    changedAt: (r.changed_at as Date).toISOString(),
  }));
  const last = rows[rows.length - 1];
  // Always a position to resume from (null only before any event exists):
  // hasMore says whether to ask again now or on the next poll.
  const nextCursor = last ? encodeCursor(last.changed_at as Date, last.id as string) : input.cursor ?? null;
  return { events, nextCursor, hasMore: result.rows.length > limit };
};
