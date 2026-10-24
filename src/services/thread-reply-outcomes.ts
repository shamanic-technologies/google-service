import { env } from "../env";
import { query } from "../db/client";

/**
 * LEDGER-HISTORY-1024 (doctrine: agent-config skill `cost-accounting`): a Gmail
 * thread reply this service sent IS a `message_sent` of the person, the same
 * outcome as an email Instantly sends. Nobody else declares it (email-gateway
 * only routes the follow-up here), so this service states it in runs-service's
 * ledger, on the request run that sent it.
 *
 * Grain: one sent reply = one row of `gmail_thread_reply_sends` = ONE
 * `message_sent` produced on its request run, which also CONSUMED the person's
 * `message_written` and `email_checked` (same declaration as every send of the
 * fleet, instantly-service `send-outcomes.ts`). Subject = the person's lead in
 * lead-service, as named by the caller (`leadId` on the request). A row without
 * a lead id is never declared under an invented subject: it stays undeclared,
 * visible as such.
 *
 * Never on the send path: the email leaves whatever the ledger says. The sweep
 * declares every recorded, undeclared send through the batch door with
 * `occurredAt` = when Gmail accepted it (a past send declared today counts on
 * its own day). Idempotent at runs-service per (run, direction, key, subject):
 * a replay answers `already_recorded` and writes nothing.
 */
export const THREAD_REPLY_PRODUCED_OUTCOME = "message_sent";
export const THREAD_REPLY_CONSUMED_OUTCOMES = ["message_written", "email_checked"] as const;
export const OUTCOME_SUBJECT_SERVICE = "lead-service";
/** The service name our runs carry (`runs.service_name`): the run's owner. */
const RUN_SERVICE_NAME = "google";
const BATCH_LIMIT = 200;
const DECLARE_TIMEOUT_MS = 15_000;
const FIRST_TICK_DELAY_MS = 60 * 1000;
const INTERVAL_MS = 5 * 60 * 1000;

export interface ThreadReplySend {
  orgId: string;
  gmailMessageId: string;
  threadId: string;
  mailbox: string;
  from: string;
  to: string;
  runId: string;
  leadId: string | null;
  sentAt: Date;
}

/** Record a sent reply (idempotent on the Gmail message id). */
export const recordThreadReplySend = async (s: ThreadReplySend): Promise<void> => {
  await query(
    `INSERT INTO gmail_thread_reply_sends
       (org_id, gmail_message_id, thread_id, mailbox, from_address, to_address, run_id, lead_id, sent_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (org_id, gmail_message_id) DO NOTHING`,
    [s.orgId, s.gmailMessageId, s.threadId, s.mailbox, s.from, s.to, s.runId, s.leadId, s.sentAt]
  );
};

export interface Occurrence {
  outcomeKey: string;
  subjectService: string;
  subjectId: string;
}

/** What one sent reply's run declares about the person it emailed. */
export const buildThreadReplyDeclaration = (leadId: string) => {
  const subject = { subjectService: OUTCOME_SUBJECT_SERVICE, subjectId: leadId };
  return {
    produced: [{ outcomeKey: THREAD_REPLY_PRODUCED_OUTCOME, ...subject }] as Occurrence[],
    consumed: THREAD_REPLY_CONSUMED_OUTCOMES.map((outcomeKey) => ({ outcomeKey, ...subject })) as Occurrence[],
  };
};

export type DeclarationMark = "declared" | "run_gone" | "refused";

/**
 * How a batch answer ends ONE row. 2xx = recorded / already recorded. 422
 * `invalid_runs` names the refused runs: `run_not_found` = gone, any other
 * reason = refused for good (logged). Anything else (401, 5xx, a 400
 * `unknown_outcome_key` from an unreadable catalogue) = retry next tick.
 */
export const classifyBatchAnswer = (
  status: number,
  body: string,
  runIds: string[]
): Map<string, DeclarationMark | "retry"> => {
  const out = new Map<string, DeclarationMark | "retry">();
  if (status >= 200 && status < 300) {
    for (const id of runIds) out.set(id, "declared");
    return out;
  }
  if (status === 422) {
    let invalid: Array<{ runId: string; reason: string }> = [];
    try {
      invalid = (JSON.parse(body) as { details?: { invalid?: typeof invalid } }).details?.invalid ?? [];
    } catch {
      invalid = [];
    }
    const byRun = new Map(invalid.map((i) => [i.runId.toLowerCase(), i.reason]));
    // All or nothing: the runs NOT listed were not written either, retry them alone.
    for (const id of runIds) {
      const reason = byRun.get(id.toLowerCase());
      out.set(id, reason === undefined ? "retry" : reason === "run_not_found" ? "run_gone" : "refused");
    }
    return out;
  }
  for (const id of runIds) out.set(id, "retry");
  return out;
};

interface PendingRow {
  id: string;
  run_id: string;
  lead_id: string;
  sent_at: Date;
}

export interface DeclareSummary {
  pending: number;
  declared: number;
  runGone: number;
  refused: number;
  retry: number;
}

/** Declare every recorded, undeclared reply that names its lead (newest first). */
export const declarePendingThreadReplyOutcomes = async (): Promise<DeclareSummary> => {
  const summary: DeclareSummary = { pending: 0, declared: 0, runGone: 0, refused: 0, retry: 0 };
  // A run sends one reply (one request), but group defensively: one batch entry per run.
  const res = await query(
    `SELECT id, run_id, lead_id, sent_at FROM gmail_thread_reply_sends
     WHERE outcomes_declaration IS NULL AND lead_id IS NOT NULL
     ORDER BY sent_at DESC LIMIT $1`,
    [BATCH_LIMIT]
  );
  const rows = res.rows as unknown as PendingRow[];
  summary.pending = rows.length;
  if (rows.length === 0) return summary;

  const byRun = new Map<string, PendingRow[]>();
  for (const r of rows) byRun.set(r.run_id, [...(byRun.get(r.run_id) ?? []), r]);
  const runs = [...byRun.entries()].map(([runId, rs]) => {
    const occ = rs.map((r) => buildThreadReplyDeclaration(r.lead_id));
    const earliest = rs.reduce((a, r) => (r.sent_at < a ? r.sent_at : a), rs[0].sent_at);
    return {
      runId,
      produced: occ.flatMap((o) => o.produced),
      consumed: occ.flatMap((o) => o.consumed),
      occurredAt: new Date(earliest).toISOString(),
    };
  });

  const answer = await fetch(`${env.RUNS_SERVICE_URL}/v1/platform-runs/outcomes/batch`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.RUNS_SERVICE_API_KEY,
      "x-service-name": RUN_SERVICE_NAME,
    },
    body: JSON.stringify({ runs }),
    signal: AbortSignal.timeout(DECLARE_TIMEOUT_MS),
  });
  const body = await answer.text();
  const marks = classifyBatchAnswer(answer.status, body, [...byRun.keys()]);
  if (answer.status >= 300) {
    console.error(`[google-service] thread-reply outcomes: runs-service ${answer.status} body=${body.slice(0, 500)}`);
  }

  for (const [runId, mark] of marks) {
    if (mark === "retry") {
      summary.retry += byRun.get(runId)!.length;
      continue;
    }
    const ids = byRun.get(runId)!.map((r) => r.id);
    await query(
      `UPDATE gmail_thread_reply_sends
         SET outcomes_declaration = $1, outcomes_declared_at = NOW(), outcomes_error = $2
       WHERE id = ANY($3::uuid[])`,
      [mark, mark === "declared" ? null : body.slice(0, 1000), ids]
    );
    if (mark === "declared") summary.declared += ids.length;
    else if (mark === "run_gone") summary.runGone += ids.length;
    else summary.refused += ids.length;
  }
  return summary;
};

/** First tick ~60 s after boot (deploys recreate the container often), then every 5 min, never overlapping. */
export const startThreadReplyOutcomes = (): void => {
  const tick = async () => {
    try {
      const s = await declarePendingThreadReplyOutcomes();
      if (s.pending > 0) console.log(`[google-service] thread-reply outcomes: ${JSON.stringify(s)}`);
    } catch (err) {
      console.error(`[google-service] thread-reply outcomes tick failed: ${(err as Error).message}`);
    }
    setTimeout(tick, INTERVAL_MS).unref();
  };
  setTimeout(tick, FIRST_TICK_DELAY_MS).unref();
};
