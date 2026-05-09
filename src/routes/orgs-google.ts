import { Router, Request, Response, NextFunction } from "express";
import { query } from "../db/client";
import { env } from "../env";
import { apiKeyAuth } from "../middleware/api-key-auth";
import { validateBody, validateQuery } from "../middleware/validate";
import { traceEvent } from "../lib/trace-event";
import {
  GoogleAuthStartBodySchema,
  GoogleAuthCallbackQuerySchema,
  GoogleMessagesQuerySchema,
  GoogleContactsQuerySchema,
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
import {
  listOrgGoogleAccounts,
  upsertGoogleToken,
  type GoogleAccountToken,
} from "../services/google-tokens";
import { ingestGmailForAccount } from "../services/gmail-ingest";
import { ingestPeopleForAccount } from "../services/people-ingest";

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

// ─── POST /orgs/google/sync ───

router.post(
  "/sync",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const orgId = req.orgId!;
      const accounts = await listOrgGoogleAccounts(orgId);

      const summary = {
        accounts: accounts.length,
        gmail: { inserted: 0, updated: 0, unchanged: 0 },
        contacts: { inserted: 0, updated: 0, unchanged: 0, deleted: 0 },
      };

      for (const account of accounts) {
        const [gmailResult, peopleResult] = await Promise.all([
          ingestGmailForAccount(account, callerCtx(req), req.runId!, req.featureSlug, req.brandId),
          ingestPeopleForAccount(account, callerCtx(req), req.runId!, req.featureSlug, req.brandId),
        ]);
        summary.gmail.inserted += gmailResult.inserted;
        summary.gmail.updated += gmailResult.updated;
        summary.gmail.unchanged += gmailResult.unchanged;
        summary.contacts.inserted += peopleResult.inserted;
        summary.contacts.updated += peopleResult.updated;
        summary.contacts.unchanged += peopleResult.unchanged;
        summary.contacts.deleted += peopleResult.deleted;
      }

      res.json(summary);
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

      const conditions: string[] = ["org_id = $1"];
      const params: unknown[] = [orgId];

      if (q.account_id) {
        params.push(q.account_id);
        conditions.push(`google_account_id = $${params.length}`);
      }
      if (q.thread_id) {
        params.push(q.thread_id);
        conditions.push(`thread_id = $${params.length}`);
      }
      if (cursor) {
        params.push(cursor.fetchedAt);
        params.push(cursor.id);
        conditions.push(
          `(fetched_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`
        );
      }

      params.push(limit + 1);
      const rows = await query(
        `SELECT id, google_account_id, gmail_message_id, thread_id, history_id, payload, fetched_at
           FROM gmail_messages_raw
           WHERE ${conditions.join(" AND ")}
           ORDER BY fetched_at DESC, id DESC
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
      }));

      const nextCursor = hasMore
        ? encodeCursor({
            fetchedAt: (slice[slice.length - 1].fetched_at as Date).toISOString(),
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

      const conditions: string[] = ["org_id = $1"];
      const params: unknown[] = [orgId];

      if (q.account_id) {
        params.push(q.account_id);
        conditions.push(`google_account_id = $${params.length}`);
      }
      if (q.query) {
        params.push(`%${q.query}%`);
        conditions.push(`payload::text ILIKE $${params.length}`);
      }
      if (cursor) {
        params.push(cursor.fetchedAt);
        params.push(cursor.id);
        conditions.push(
          `(fetched_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`
        );
      }

      params.push(limit + 1);
      const rows = await query(
        `SELECT id, google_account_id, resource_name, etag, payload, fetched_at
           FROM google_contacts_raw
           WHERE ${conditions.join(" AND ")}
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
      }));

      const nextCursor = hasMore
        ? encodeCursor({
            fetchedAt: (slice[slice.length - 1].fetched_at as Date).toISOString(),
            id: slice[slice.length - 1].id as string,
          })
        : null;

      res.json({ items, nextCursor });
    } catch (err) {
      next(err);
    }
  }
);

// ─── Cursor helpers ───

interface CursorPayload {
  fetchedAt: string;
  id: string;
}

const encodeCursor = (c: CursorPayload): string =>
  Buffer.from(JSON.stringify(c)).toString("base64url");

const decodeCursor = (raw: string | undefined): CursorPayload | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf-8"));
    if (typeof parsed.fetchedAt !== "string" || typeof parsed.id !== "string") {
      throw new Error("invalid cursor shape");
    }
    return { fetchedAt: parsed.fetchedAt, id: parsed.id };
  } catch (err) {
    throw new Error(`invalid cursor: ${(err as Error).message}`);
  }
};

export default router;
