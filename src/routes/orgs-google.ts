import { Router, Request, Response, NextFunction } from "express";
import { query } from "../db/client";
import { env } from "../env";
import { apiKeyAuth } from "../middleware/api-key-auth";
import { validateBody, validateParams, validateQuery } from "../middleware/validate";
import { traceEvent } from "../lib/trace-event";
import {
  GoogleAuthStartBodySchema,
  GoogleAuthCallbackQuerySchema,
  GoogleMessagesQuerySchema,
  GoogleContactsQuerySchema,
  GoogleSyncJobIdParamSchema,
} from "../schemas";
import { getGoogleOAuthClient, type CallerContext } from "../services/key-service";
import {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  fetchGoogleUserEmail,
  generatePkcePair,
  generateState,
  GOOGLE_CRM_SCOPES,
} from "../services/google-oauth";
import { upsertGoogleToken } from "../services/google-tokens";
import { syncOrg } from "../services/sync";

const router = Router();

router.use(apiKeyAuth);

const callerCtx = (req: Request): CallerContext => ({
  method: req.method,
  path: req.route?.path ?? req.path,
});

// ─── POST /orgs/google/auth/start ───

router.post(
  "/auth/start",
  validateBody(GoogleAuthStartBodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const orgId = req.orgId!;
      const userId = req.userId!;
      const body = req.validatedBody as { redirectUri?: string };
      const redirectUri = body.redirectUri ?? env.GOOGLE_OAUTH_REDIRECT_URI;
      if (!redirectUri) {
        res.status(500).json({
          error:
            "GOOGLE_OAUTH_REDIRECT_URI is not configured and no redirectUri was provided in the request body",
        });
        return;
      }

      traceEvent(
        req.runId!,
        { service: "google-service", event: "google-crm-auth-start", detail: `orgId=${orgId}` },
        req.headers
      ).catch(() => {});

      const oauth = await getGoogleOAuthClient(callerCtx(req), req.runId, req.featureSlug, req.brandId);
      const { verifier, challenge } = generatePkcePair();
      const state = generateState();

      await query(
        `INSERT INTO google_oauth_pending
            (org_id, user_id, state, pkce_verifier, redirect_uri, feature_slug, brand_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [orgId, userId, state, verifier, redirectUri, req.featureSlug ?? null, req.brandId ?? null]
      );

      const url = buildAuthorizeUrl({
        clientId: oauth.clientId,
        redirectUri,
        state,
        pkceChallenge: challenge,
      });

      res.json({ url, state });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /orgs/google/auth/callback ───

router.get(
  "/auth/callback",
  validateQuery(GoogleAuthCallbackQuerySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const orgId = req.orgId!;
      const userId = req.userId!;
      const { code, state } = req.validatedQuery as { code: string; state: string };

      const pendingResult = await query(
        `SELECT pkce_verifier, redirect_uri, feature_slug, brand_id
           FROM google_oauth_pending
           WHERE org_id = $1 AND state = $2 AND expires_at > NOW()`,
        [orgId, state]
      );

      if (pendingResult.rows.length === 0) {
        res.status(400).json({ error: "Invalid or expired OAuth state" });
        return;
      }

      const pending = pendingResult.rows[0] as {
        pkce_verifier: string;
        redirect_uri: string;
        feature_slug: string | null;
        brand_id: string | null;
      };

      await query(
        `DELETE FROM google_oauth_pending WHERE org_id = $1 AND state = $2`,
        [orgId, state]
      );

      const oauth = await getGoogleOAuthClient(callerCtx(req), req.runId, req.featureSlug, req.brandId);
      const tokens = await exchangeCodeForTokens({
        clientId: oauth.clientId,
        clientSecret: oauth.clientSecret,
        code,
        redirectUri: pending.redirect_uri,
        pkceVerifier: pending.pkce_verifier,
      });

      const email = await fetchGoogleUserEmail(tokens.access_token);
      const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

      const stored = await upsertGoogleToken({
        orgId,
        userId,
        googleAccountEmail: email,
        refreshToken: tokens.refresh_token,
        accessToken: tokens.access_token,
        accessTokenExpiresAt: expiresAt,
        scopes: tokens.scope ?? GOOGLE_CRM_SCOPES.join(" "),
        featureSlug: pending.feature_slug ?? undefined,
        brandId: pending.brand_id ?? undefined,
      });

      traceEvent(
        req.runId!,
        { service: "google-service", event: "google-crm-auth-callback-done", detail: `email=${email}` },
        req.headers
      ).catch(() => {});

      res.json({
        success: true,
        googleAccountId: stored.id,
        googleAccountEmail: stored.googleAccountEmail,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /orgs/google/accounts ───

router.get(
  "/accounts",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const orgId = req.orgId!;
      const result = await query(
        `SELECT google_account_email, scopes, created_at
           FROM google_oauth_tokens
           WHERE org_id = $1
           ORDER BY created_at ASC`,
        [orgId]
      );

      const accounts = result.rows.map((row) => ({
        email: row.google_account_email as string,
        status: "active" as const,
        scopes: (row.scopes as string).split(" ").filter((s) => s.length > 0),
        connectedAt: (row.created_at as Date).toISOString(),
      }));

      res.json({ accounts });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /orgs/google/sync (async) ───
//
// Inserts a row in google_sync_jobs (status='running'), fires the actual ingest
// in a detached promise, and returns 202 immediately with {jobId, status}.
// Synchronous execution previously timed out the dashboard's Vercel proxy on
// large mailboxes (FUNCTION_INVOCATION_TIMEOUT, 300s cap). Caller polls
// GET /orgs/google/sync/:jobId until status != 'running'.
router.post(
  "/sync",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const orgId = req.orgId!;
      const userId = req.userId!;

      const insertResult = await query(
        `INSERT INTO google_sync_jobs (org_id, user_id, status)
         VALUES ($1, $2, 'running')
         RETURNING id`,
        [orgId, userId]
      );
      const jobId = insertResult.rows[0].id as string;

      runSyncInBackground({
        jobId,
        orgId,
        callerCtx: callerCtx(req),
        runId: req.runId!,
        featureSlug: req.featureSlug,
        brandId: req.brandId,
      });

      res.status(202).json({ jobId, status: "running" });
    } catch (err) {
      next(err);
    }
  }
);

interface RunSyncArgs {
  jobId: string;
  orgId: string;
  callerCtx: CallerContext;
  runId: string;
  featureSlug?: string;
  brandId?: string;
}

const runSyncInBackground = (args: RunSyncArgs): void => {
  void runSync(args).catch((err) => {
    console.error(
      `[google-service] runSync unexpected failure jobId=${args.jobId}: ${(err as Error).message}`
    );
  });
};

const runSync = async (args: RunSyncArgs): Promise<void> => {
  const { jobId, orgId, callerCtx: ctx, runId, featureSlug, brandId } = args;
  try {
    const summary = await syncOrg(orgId, ctx, runId, featureSlug, brandId);
    await query(
      `UPDATE google_sync_jobs
          SET status = 'succeeded', summary = $1, finished_at = NOW()
          WHERE id = $2`,
      [summary, jobId]
    );
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    console.error(`[google-service] sync job ${jobId} failed: ${message}`);
    await query(
      `UPDATE google_sync_jobs
          SET status = 'failed', error = $1, finished_at = NOW()
          WHERE id = $2`,
      [message, jobId]
    ).catch((updateErr) => {
      console.error(
        `[google-service] failed to mark sync job ${jobId} as failed: ${(updateErr as Error).message}`
      );
    });
  }
};

// ─── GET /orgs/google/sync/:jobId ───

router.get(
  "/sync/:jobId",
  validateParams(GoogleSyncJobIdParamSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const orgId = req.orgId!;
      const { jobId } = req.validatedParams as { jobId: string };

      const result = await query(
        `SELECT id, status, summary, error, started_at, finished_at
           FROM google_sync_jobs
           WHERE org_id = $1 AND id = $2`,
        [orgId, jobId]
      );

      if (result.rows.length === 0) {
        res.status(404).json({ error: "Sync job not found" });
        return;
      }

      const row = result.rows[0] as {
        id: string;
        status: "running" | "succeeded" | "failed";
        summary: unknown;
        error: string | null;
        started_at: Date;
        finished_at: Date | null;
      };

      res.json({
        jobId: row.id,
        status: row.status,
        summary: row.summary ?? null,
        error: row.error,
        startedAt: row.started_at.toISOString(),
        finishedAt: row.finished_at ? row.finished_at.toISOString() : null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /orgs/google/messages ───

router.get(
  "/messages",
  validateQuery(GoogleMessagesQuerySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const orgId = req.orgId!;
      const q = req.validatedQuery as {
        limit?: number;
        cursor?: string;
        account_id?: string;
        thread_id?: string;
      };

      const limit = q.limit ?? 50;
      const cursor = decodeCursor(q.cursor);

      // Bronze (m) is the primary source-of-truth row set (payload preserved,
      // every row returned); silver (s) is LEFT JOINed to add the typed fields
      // additively. Sort by message send time (sent_at) desc, falling back to
      // bronze fetched_at when a row is not yet parsed.
      const conditions: string[] = ["m.org_id = $1"];
      const params: unknown[] = [orgId];

      if (q.account_id) {
        params.push(q.account_id);
        conditions.push(`m.google_account_id = $${params.length}`);
      }
      if (q.thread_id) {
        params.push(q.thread_id);
        conditions.push(`m.thread_id = $${params.length}`);
      }
      if (cursor) {
        params.push(cursor.ts);
        params.push(cursor.id);
        conditions.push(
          `(COALESCE(s.sent_at, m.fetched_at), m.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`
        );
      }

      params.push(limit + 1);
      const rows = await query(
        `SELECT m.id, m.google_account_id, m.gmail_message_id, m.thread_id, m.history_id,
                m.payload, m.fetched_at,
                s.from_email, s.from_name, s.to_emails, s.subject, s.snippet,
                s.sent_at, s.labels,
                COALESCE(s.sent_at, m.fetched_at) AS sort_at
           FROM gmail_messages_raw m
           LEFT JOIN gmail_messages_silver s
             ON s.org_id = m.org_id AND s.gmail_message_id = m.gmail_message_id
           WHERE ${conditions.join(" AND ")}
           ORDER BY COALESCE(s.sent_at, m.fetched_at) DESC, m.id DESC
           LIMIT $${params.length}`,
        params
      );

      const hasMore = rows.rows.length > limit;
      const slice = hasMore ? rows.rows.slice(0, limit) : rows.rows;
      const items = slice.map((row) => ({
        id: row.id as string,
        googleAccountId: row.google_account_id as string,
        gmailMessageId: row.gmail_message_id as string,
        threadId: row.thread_id as string,
        historyId: String(row.history_id),
        payload: row.payload,
        fetchedAt: (row.fetched_at as Date).toISOString(),
        // Typed silver fields (null/[] when the row is not yet parsed).
        fromEmail: (row.from_email as string | null) ?? null,
        fromName: (row.from_name as string | null) ?? null,
        to: (row.to_emails as string[] | null) ?? [],
        subject: (row.subject as string | null) ?? null,
        snippet: (row.snippet as string | null) ?? null,
        sentAt: toIso(row.sent_at),
        labels: (row.labels as string[] | null) ?? [],
      }));

      const nextCursor = hasMore
        ? encodeCursor({
            ts: sortTs(slice[slice.length - 1]),
            id: slice[slice.length - 1].id as string,
          })
        : null;

      res.json({ items, nextCursor });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /orgs/google/contacts ───

router.get(
  "/contacts",
  validateQuery(GoogleContactsQuerySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const orgId = req.orgId!;
      const q = req.validatedQuery as {
        limit?: number;
        cursor?: string;
        account_id?: string;
        query?: string;
      };

      const limit = q.limit ?? 50;
      const cursor = decodeCursor(q.cursor);

      // Bronze (c) LEFT JOIN silver (s) for the typed fields, additively. Dedup:
      // contacts that share a primary_email (Gmail-collected + address-book) are
      // collapsed to one row; rows without an email key on resource_name (always
      // unique) so they are never dropped. Pagination stays on (fetched_at, id).
      const innerConditions: string[] = ["c.org_id = $1"];
      const params: unknown[] = [orgId];

      if (q.account_id) {
        params.push(q.account_id);
        innerConditions.push(`c.google_account_id = $${params.length}`);
      }
      if (q.query) {
        params.push(`%${q.query}%`);
        innerConditions.push(`c.payload::text ILIKE $${params.length}`);
      }

      const outerConditions: string[] = ["rn = 1"];
      if (cursor) {
        params.push(cursor.ts);
        params.push(cursor.id);
        outerConditions.push(
          `(fetched_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`
        );
      }

      params.push(limit + 1);
      const rows = await query(
        `WITH ranked AS (
           SELECT c.id, c.google_account_id, c.resource_name, c.etag, c.payload, c.fetched_at,
                  s.display_name, s.primary_email, s.emails, s.phones, s.organization,
                  s.job_title, s.photo_url, s.updated_at AS silver_updated_at, s.deleted,
                  ROW_NUMBER() OVER (
                    PARTITION BY COALESCE(lower(s.primary_email), c.resource_name)
                    ORDER BY c.fetched_at DESC, c.id DESC
                  ) AS rn
             FROM google_contacts_raw c
             LEFT JOIN google_contacts_silver s
               ON s.org_id = c.org_id AND s.resource_name = c.resource_name
             WHERE ${innerConditions.join(" AND ")}
         )
         SELECT * FROM ranked
         WHERE ${outerConditions.join(" AND ")}
         ORDER BY fetched_at DESC, id DESC
         LIMIT $${params.length}`,
        params
      );

      const hasMore = rows.rows.length > limit;
      const slice = hasMore ? rows.rows.slice(0, limit) : rows.rows;
      const items = slice.map((row) => ({
        id: row.id as string,
        googleAccountId: row.google_account_id as string,
        resourceName: row.resource_name as string,
        etag: (row.etag as string | null) ?? null,
        payload: row.payload,
        fetchedAt: (row.fetched_at as Date).toISOString(),
        // Typed silver fields (null/[] when the row is not yet parsed).
        displayName: (row.display_name as string | null) ?? null,
        primaryEmail: (row.primary_email as string | null) ?? null,
        emails: (row.emails as string[] | null) ?? [],
        phones: (row.phones as string[] | null) ?? [],
        organization: (row.organization as string | null) ?? null,
        jobTitle: (row.job_title as string | null) ?? null,
        photoUrl: (row.photo_url as string | null) ?? null,
        updatedAt: toIso(row.silver_updated_at),
        deleted: (row.deleted as boolean | null) ?? false,
      }));

      const nextCursor = hasMore
        ? encodeCursor({
            ts: (slice[slice.length - 1].fetched_at as Date).toISOString(),
            id: slice[slice.length - 1].id as string,
          })
        : null;

      res.json({ items, nextCursor });
    } catch (err) {
      next(err);
    }
  }
);

// ─── Field helpers ───

// Coerce a pg timestamptz (Date) or null into an ISO string or null.
const toIso = (v: unknown): string | null =>
  v instanceof Date ? v.toISOString() : null;

// Sort timestamp for a message row: the silver sent_at when present (aliased as
// sort_at in the SQL), else bronze fetched_at. Robust to rows lacking sort_at.
const sortTs = (row: Record<string, unknown>): string => {
  if (row.sort_at instanceof Date) return row.sort_at.toISOString();
  if (row.sent_at instanceof Date) return row.sent_at.toISOString();
  return (row.fetched_at as Date).toISOString();
};

// ─── Cursor helpers ───

interface CursorPayload {
  ts: string;
  id: string;
}

const encodeCursor = (c: CursorPayload): string =>
  Buffer.from(JSON.stringify(c)).toString("base64url");

const decodeCursor = (raw: string | undefined): CursorPayload | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf-8"));
    if (typeof parsed.ts !== "string" || typeof parsed.id !== "string") {
      throw new Error("invalid cursor shape");
    }
    return { ts: parsed.ts, id: parsed.id };
  } catch (err) {
    throw new Error(`invalid cursor: ${(err as Error).message}`);
  }
};

export default router;
