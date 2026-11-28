import { query } from "../db/client";
import { env } from "../env";

/**
 * Staff feed: is every Google connection still being read? (GMAIL-SYNC-STALL-1128)
 *
 * On 2026-11-27 18:20 UTC the four Gmail grants were revoked at Google (security
 * response to the token leak). Every 15-min pass then failed with `invalid_grant`
 * and nothing showed it: GET /orgs/google/accounts still said `active`, the
 * failures lived only in the container log, and agents read a mirror frozen for
 * 23 h as if it were current. This feed serves, per connection (Gmail mailbox,
 * Google Calendar, Search Console account), the same per-connection verdict as
 * crm-service's connector intake (Monitoring > Connected tools): when it was last
 * read, why it fails, and the records the vendor dated on each UTC day. Red only
 * when something is broken: a never-read connection is "not yet", not red.
 */

export const INTAKE_RULE = {
  historyDays: 90,
  minActiveDays: 10,
  minQuietDays: 2,
} as const;

// A read is late after a few missed passes of its own cadence.
const lateAfterMinutes = {
  gmail: () => env.GOOGLE_GMAIL_FRESH_INTERVAL_MINUTES * 4,
  "google-calendar": () => env.GOOGLE_CALENDAR_SYNC_INTERVAL_MINUTES * 4,
  "google-search-console": () => env.GOOGLE_SEARCH_CONSOLE_SYNC_INTERVAL_HOURS * 60 * 2 + 60,
} as const;

type Source = keyof typeof lateAfterMinutes;

export interface IntakeReason {
  code: "reconnect_required" | "sync_error" | "sync_late" | "quiet_unusual";
  text: string;
}

export interface IntakeConnection {
  source: Source;
  connectionId: string;
  orgId: string;
  brandId: string | null;
  account: string;
  syncStatus: "active" | "reconnect_required" | "sync_failing" | "gmail_unavailable";
  lastSyncedAt: string | null;
  lastError: string | null;
  status: "ok" | "red" | "paused";
  reasons: IntakeReason[];
  newestRecordDay: string | null;
  quietDays: number | null;
  usualLongestQuietDays: number | null;
  activeDaysInHistory: number;
  byDay: { day: string; records: number }[];
}

export interface ConnectorIntake {
  generatedAt: string;
  days: number;
  rule: {
    historyDays: number;
    minActiveDays: number;
    minQuietDays: number;
    syncLateAfterMinutes: Record<Source, number>;
  };
  status: "ok" | "red";
  connections: IntakeConnection[];
}

const DAY_MS = 86_400_000;
const dayKey = (d: Date): string => d.toISOString().slice(0, 10);
const iso = (d: unknown): string | null => (d ? (d as Date).toISOString() : null);

interface RawConnection {
  source: Source;
  id: string;
  orgId: string;
  brandId: string | null;
  account: string;
  createdAt: Date;
  lastSyncedAt: Date | null;
  lastError: string | null;
  reconnectRequired: boolean;
  paused: boolean;
}

/** Days between the newest active day and today, and the longest gap between active days before it. */
export const quietFigures = (
  activeDays: string[],
  today: string
): { newest: string | null; quietDays: number | null; usualLongest: number | null } => {
  if (activeDays.length === 0) return { newest: null, quietDays: null, usualLongest: null };
  const sorted = [...activeDays].sort();
  const t = (d: string) => Date.parse(`${d}T00:00:00Z`);
  let usual = 0;
  for (let i = 1; i < sorted.length; i++) {
    usual = Math.max(usual, Math.round((t(sorted[i]) - t(sorted[i - 1])) / DAY_MS) - 1);
  }
  const newest = sorted[sorted.length - 1];
  return { newest, quietDays: Math.round((t(today) - t(newest)) / DAY_MS), usualLongest: usual };
};

/** The verdict of one connection, from its stored read state and its records per day. Pure. */
export const judgeConnection = (
  c: RawConnection,
  recordsByDay: Map<string, number>,
  days: number,
  now: Date,
  bootedAt: Date
): IntakeConnection => {
  const today = dayKey(now);
  const reasons: IntakeReason[] = [];
  const late = lateAfterMinutes[c.source]() * 60_000;

  if (c.reconnectRequired) {
    reasons.push({ code: "reconnect_required", text: "Google refused our access: the account must sign in again" });
  } else if (c.lastError) {
    reasons.push({ code: "sync_error", text: c.lastError });
  }
  // Late = the last good read is older than a few missed passes. A connection
  // never read yet counts from when it (or this process) started: a fresh
  // connect or a deploy is "not yet", never red.
  const since = c.lastSyncedAt ?? new Date(Math.max(c.createdAt.getTime(), bootedAt.getTime()));
  if (!c.reconnectRequired && !c.paused && now.getTime() - since.getTime() > late) {
    reasons.push({
      code: "sync_late",
      text: c.lastSyncedAt ? `no good read since ${c.lastSyncedAt.toISOString()}` : "never read",
    });
  }

  const activeDays = [...recordsByDay.entries()].filter(([, n]) => n > 0).map(([d]) => d);
  const q = quietFigures(activeDays, today);
  if (
    c.source === "gmail" &&
    !c.paused &&
    activeDays.length >= INTAKE_RULE.minActiveDays &&
    q.quietDays != null &&
    q.usualLongest != null &&
    q.quietDays > Math.max(q.usualLongest, INTAKE_RULE.minQuietDays)
  ) {
    reasons.push({
      code: "quiet_unusual",
      text: `no new mail for ${q.quietDays} days, usually never more than ${q.usualLongest}`,
    });
  }

  const byDay: { day: string; records: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = dayKey(new Date(now.getTime() - i * DAY_MS));
    byDay.push({ day: d, records: recordsByDay.get(d) ?? 0 });
  }

  return {
    source: c.source,
    connectionId: c.id,
    orgId: c.orgId,
    brandId: c.brandId,
    account: c.account,
    syncStatus: c.paused
      ? "gmail_unavailable"
      : c.reconnectRequired
        ? "reconnect_required"
        : c.lastError
          ? "sync_failing"
          : "active",
    lastSyncedAt: iso(c.lastSyncedAt),
    lastError: c.lastError,
    status: c.paused ? "paused" : reasons.length > 0 ? "red" : "ok",
    reasons,
    newestRecordDay: q.newest,
    quietDays: q.quietDays,
    usualLongestQuietDays: q.usualLongest,
    activeDaysInHistory: activeDays.length,
    byDay,
  };
};

const isDeadGrantMessage = (m: string | null) => m != null && m.includes("invalid_grant");

const bootedAt = new Date();

export const getConnectorIntake = async (days: number, now = new Date()): Promise<ConnectorIntake> => {
  const historyStart = new Date(now.getTime() - INTAKE_RULE.historyDays * DAY_MS);

  const [mail, mailDays, cal, gsc, gscDays] = await Promise.all([
    query(
      `SELECT id, org_id, brand_id, google_account_email, created_at, last_synced_at,
              last_sync_error, reconnect_required, gmail_unavailable_at
         FROM google_oauth_tokens WHERE disconnected_at IS NULL`
    ),
    // Mail the mailbox holds per UTC day of its own date (Gmail's), over the
    // history window. The (org_id, sent_at) index carries it.
    query(
      `SELECT google_account_id, to_char(sent_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, count(*)::int AS n
         FROM gmail_messages_silver
        WHERE org_id IN (SELECT DISTINCT org_id FROM google_oauth_tokens WHERE disconnected_at IS NULL)
          AND sent_at >= $1 AND sent_at <= $2
        GROUP BY 1, 2`,
      [historyStart, now]
    ),
    query(
      `SELECT id, org_id, google_account_email, created_at, last_synced_at, last_sync_error
         FROM google_calendar_accounts`
    ),
    query(
      `SELECT id, org_id, google_account_email, created_at, last_synced_at, last_sync_error, reconnect_required
         FROM google_search_console_accounts`
    ),
    query(
      `SELECT p.account_id, to_char(d.search_date, 'YYYY-MM-DD') AS day, sum(d.clicks)::int AS n
         FROM google_search_console_click_days d
         JOIN google_search_console_properties p ON p.id = d.property_id
        WHERE p.account_id IS NOT NULL AND d.search_date >= $1::date
        GROUP BY 1, 2`,
      [dayKey(historyStart)]
    ),
  ]);

  const perAccount = (rows: Record<string, unknown>[], key: string) => {
    const m = new Map<string, Map<string, number>>();
    for (const r of rows) {
      const id = r[key] as string;
      if (!m.has(id)) m.set(id, new Map());
      m.get(id)!.set(r.day as string, r.n as number);
    }
    return m;
  };
  const mailByAccount = perAccount(mailDays.rows, "google_account_id");
  const gscByAccount = perAccount(gscDays.rows, "account_id");

  const raw: { c: RawConnection; byDay: Map<string, number> }[] = [
    ...mail.rows.map((r) => ({
      c: {
        source: "gmail" as const,
        id: r.id as string,
        orgId: r.org_id as string,
        brandId: (r.brand_id as string | null) ?? null,
        account: r.google_account_email as string,
        createdAt: r.created_at as Date,
        lastSyncedAt: (r.last_synced_at as Date | null) ?? null,
        lastError: (r.last_sync_error as string | null) ?? null,
        reconnectRequired: r.reconnect_required === true,
        paused: r.gmail_unavailable_at != null,
      },
      byDay: mailByAccount.get(r.id as string) ?? new Map(),
    })),
    ...cal.rows.map((r) => ({
      c: {
        source: "google-calendar" as const,
        id: r.id as string,
        orgId: r.org_id as string,
        brandId: null,
        account: r.google_account_email as string,
        createdAt: r.created_at as Date,
        lastSyncedAt: (r.last_synced_at as Date | null) ?? null,
        lastError: (r.last_sync_error as string | null) ?? null,
        reconnectRequired: isDeadGrantMessage((r.last_sync_error as string | null) ?? null),
        paused: false,
      },
      byDay: new Map<string, number>(),
    })),
    ...gsc.rows.map((r) => ({
      c: {
        source: "google-search-console" as const,
        id: r.id as string,
        orgId: r.org_id as string,
        brandId: null,
        account: r.google_account_email as string,
        createdAt: r.created_at as Date,
        lastSyncedAt: (r.last_synced_at as Date | null) ?? null,
        lastError: (r.last_sync_error as string | null) ?? null,
        reconnectRequired: r.reconnect_required === true,
        paused: false,
      },
      byDay: gscByAccount.get(r.id as string) ?? new Map(),
    })),
  ];

  const rank = { red: 0, ok: 1, paused: 2 } as const;
  const connections = raw
    .map(({ c, byDay }) => judgeConnection(c, byDay, days, now, bootedAt))
    .sort((a, b) => rank[a.status] - rank[b.status] || a.source.localeCompare(b.source) || a.account.localeCompare(b.account));

  return {
    generatedAt: now.toISOString(),
    days,
    rule: {
      historyDays: INTAKE_RULE.historyDays,
      minActiveDays: INTAKE_RULE.minActiveDays,
      minQuietDays: INTAKE_RULE.minQuietDays,
      syncLateAfterMinutes: {
        gmail: lateAfterMinutes.gmail(),
        "google-calendar": lateAfterMinutes["google-calendar"](),
        "google-search-console": lateAfterMinutes["google-search-console"](),
      },
    },
    status: connections.some((c) => c.status === "red") ? "red" : "ok",
    connections,
  };
};
