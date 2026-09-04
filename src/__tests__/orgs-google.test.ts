import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";

const {
  mockQuery,
  mockGetGoogleOAuthClient,
  mockExchangeCodeForTokens,
  mockFetchGoogleUserEmail,
  mockListOrgGoogleAccounts,
  mockUpsertGoogleToken,
  mockIngestGmail,
  mockIngestPeople,
  mockIngestOtherPeople,
  mockCreateRun,
  mockUpdateRun,
} = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockGetGoogleOAuthClient: vi.fn(),
  mockExchangeCodeForTokens: vi.fn(),
  mockFetchGoogleUserEmail: vi.fn(),
  mockListOrgGoogleAccounts: vi.fn(),
  mockUpsertGoogleToken: vi.fn(),
  mockIngestGmail: vi.fn(),
  mockIngestPeople: vi.fn(),
  mockIngestOtherPeople: vi.fn(),
  mockCreateRun: vi.fn(),
  mockUpdateRun: vi.fn(),
}));

vi.mock("../env", () => ({
  env: {
    PORT: 8080,
    GOOGLE_SERVICE_DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    GOOGLE_SERVICE_API_KEY: "test-google-service-key",
    KEY_SERVICE_URL: "http://localhost:3001",
    KEY_SERVICE_API_KEY: "test-key-service-key",
    RUNS_SERVICE_URL: "http://localhost:3002",
    RUNS_SERVICE_API_KEY: "test-runs-service-key",
    BILLING_SERVICE_URL: "http://localhost:3003",
    BILLING_SERVICE_API_KEY: "test-billing-service-key",
    GOOGLE_OAUTH_REDIRECT_URI: "http://localhost:8080/orgs/google/auth/callback",
    GOOGLE_GMAIL_BACKFILL_DAYS: 365,
  },
}));

vi.mock("../db/client", () => ({
  pool: { query: vi.fn() },
  query: (...args: unknown[]) => mockQuery(...args),
}));

vi.mock("../services/key-service", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../services/key-service");
  return {
    ...actual,
    getGoogleOAuthClient: (...args: unknown[]) => mockGetGoogleOAuthClient(...args),
    storeRefreshToken: vi.fn(),
    getRefreshToken: vi.fn(),
    getGoogleCredentials: vi.fn(),
    getSerperApiKey: vi.fn(),
  };
});

vi.mock("../services/google-oauth", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../services/google-oauth");
  return {
    ...actual,
    exchangeCodeForTokens: (...args: unknown[]) => mockExchangeCodeForTokens(...args),
    fetchGoogleUserEmail: (...args: unknown[]) => mockFetchGoogleUserEmail(...args),
  };
});

vi.mock("../services/google-tokens", () => ({
  listOrgGoogleAccounts: (...args: unknown[]) => mockListOrgGoogleAccounts(...args),
  upsertGoogleToken: (...args: unknown[]) => mockUpsertGoogleToken(...args),
}));

vi.mock("../services/gmail-ingest", () => ({
  ingestGmailForAccount: (...args: unknown[]) => mockIngestGmail(...args),
}));

vi.mock("../services/people-ingest", () => ({
  ingestPeopleForAccount: (...args: unknown[]) => mockIngestPeople(...args),
  ingestOtherPeopleForAccount: (...args: unknown[]) => mockIngestOtherPeople(...args),
}));

vi.mock("../services/runs-service", () => ({
  createRun: (...args: unknown[]) => mockCreateRun(...args),
  updateRun: (...args: unknown[]) => mockUpdateRun(...args),
  addCosts: vi.fn(),
}));

vi.mock("../services/billing-client", () => ({
  authorizeCredits: vi.fn(),
}));

vi.mock("../services/serper", () => ({
  searchWeb: vi.fn(),
  searchNews: vi.fn(),
}));

vi.mock("../services/google-ads", () => ({
  createGoogleAdsClient: () => ({}),
  getCustomer: vi.fn(),
  listAccessibleAccounts: vi.fn(),
  exchangeCodeForTokens: vi.fn(),
  listCampaigns: vi.fn(),
  getCampaignDetail: vi.fn(),
  getCampaignPerformance: vi.fn(),
  listConversionActions: vi.fn(),
  createCampaign: vi.fn(),
  updateCampaign: vi.fn(),
  duplicateCampaign: vi.fn(),
}));

import { createApp } from "../app";

const app = createApp();

const TEST_ORG_ID = "00000000-0000-4000-a000-000000000001";
const TEST_USER_ID = "00000000-0000-4000-a000-000000000002";
const TEST_RUN_ID = "00000000-0000-4000-a000-000000000003";
const TEST_CHILD_RUN_ID = "00000000-0000-4000-a000-000000000004";
const TEST_ACCOUNT_UUID = "00000000-0000-4000-a000-000000000099";

const idHeaders = {
  "x-api-key": "test-google-service-key",
  "x-org-id": TEST_ORG_ID,
  "x-user-id": TEST_USER_ID,
  "x-run-id": TEST_RUN_ID,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateRun.mockResolvedValue(TEST_CHILD_RUN_ID);
  mockUpdateRun.mockResolvedValue(undefined);
  mockGetGoogleOAuthClient.mockResolvedValue({
    clientId: "client-abc",
    clientSecret: "secret-abc",
  });
  mockIngestOtherPeople.mockResolvedValue({ inserted: 0, updated: 0, unchanged: 0, deleted: 0 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── AC7: api-key + identity ───

describe("auth surface for /orgs/google/*", () => {
  it("rejects missing x-api-key with 401", async () => {
    const res = await request(app)
      .post("/orgs/google/auth/start")
      .set({ "x-org-id": TEST_ORG_ID, "x-user-id": TEST_USER_ID, "x-run-id": TEST_RUN_ID })
      .send({});
    expect(res.status).toBe(401);
  });

  it("rejects missing x-org-id with 400", async () => {
    const res = await request(app)
      .post("/orgs/google/auth/start")
      .set({ "x-api-key": "test-google-service-key", "x-user-id": TEST_USER_ID, "x-run-id": TEST_RUN_ID })
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("x-org-id");
  });
});

// ─── AC2: auth/start ───

describe("POST /orgs/google/auth/start", () => {
  it("returns Google authorize URL with both readonly scopes and persists pending row", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post("/orgs/google/auth/start")
      .set(idHeaders)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.url).toContain("accounts.google.com");
    expect(res.body.url).toContain("client-abc");
    expect(res.body.url).toContain(encodeURIComponent("https://www.googleapis.com/auth/gmail.readonly"));
    expect(res.body.url).toContain(encodeURIComponent("https://www.googleapis.com/auth/contacts.readonly"));
    expect(res.body.url).toContain("code_challenge=");
    expect(res.body.url).toContain("code_challenge_method=S256");
    expect(res.body.state).toMatch(/^[A-Za-z0-9_-]+$/);

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO google_oauth_pending"),
      expect.arrayContaining([TEST_ORG_ID, TEST_USER_ID])
    );
  });

  it("uses default redirectUri when body is empty", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post("/orgs/google/auth/start")
      .set(idHeaders)
      .send({});

    expect(res.body.url).toContain(
      encodeURIComponent("http://localhost:8080/orgs/google/auth/callback")
    );
  });
});

// ─── AC3 / AC11: auth/callback ───

describe("GET /orgs/google/auth/callback", () => {
  it("rejects invalid state with 400", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get("/orgs/google/auth/callback?code=abc&state=invalid")
      .set(idHeaders);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid or expired");
  });

  it("exchanges code, stores token, returns 200", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          {
            pkce_verifier: "verifier-x",
            redirect_uri: "http://localhost:8080/orgs/google/auth/callback",
            feature_slug: null,
            brand_id: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    mockExchangeCodeForTokens.mockResolvedValueOnce({
      access_token: "at",
      refresh_token: "rt",
      expires_in: 3600,
      scope: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/contacts.readonly",
      token_type: "Bearer",
    });
    mockFetchGoogleUserEmail.mockResolvedValueOnce("alice@example.com");
    mockUpsertGoogleToken.mockResolvedValueOnce({
      id: TEST_ACCOUNT_UUID,
      googleAccountEmail: "alice@example.com",
    });

    const res = await request(app)
      .get("/orgs/google/auth/callback?code=valid&state=valid")
      .set(idHeaders);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.googleAccountId).toBe(TEST_ACCOUNT_UUID);
    expect(res.body.googleAccountEmail).toBe("alice@example.com");

    expect(mockExchangeCodeForTokens).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "valid",
        pkceVerifier: "verifier-x",
        redirectUri: "http://localhost:8080/orgs/google/auth/callback",
      })
    );

    expect(mockUpsertGoogleToken).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: TEST_ORG_ID,
        googleAccountEmail: "alice@example.com",
        refreshToken: "rt",
      })
    );
  });
});

// ─── Async sync: POST /sync + GET /sync/:jobId ───

const TEST_JOB_ID = "00000000-0000-4000-a000-0000000000aa";
const acct = (id: string) => ({
  id,
  orgId: TEST_ORG_ID,
  userId: TEST_USER_ID,
  googleAccountEmail: `${id}@x.com`,
  refreshToken: "rt",
  accessToken: null,
  accessTokenExpiresAt: null,
  scopes: "",
  gmailHistoryId: null,
  peopleSyncToken: null,
  otherContactsSyncToken: null,
});

const isInsertJob = (sql: unknown) =>
  typeof sql === "string" && sql.includes("INSERT INTO google_sync_jobs");
const isUpdateJob = (sql: unknown) =>
  typeof sql === "string" && sql.includes("UPDATE google_sync_jobs");
const isSelectJob = (sql: unknown) =>
  typeof sql === "string" &&
  sql.includes("FROM google_sync_jobs") &&
  sql.includes("SELECT");

describe("POST /orgs/google/sync (async)", () => {
  it("returns 202 with jobId immediately and status=running", async () => {
    // INSERT google_sync_jobs returns the new row id
    mockQuery.mockImplementation(async (sql: string) => {
      if (isInsertJob(sql)) return { rows: [{ id: TEST_JOB_ID }] };
      if (isUpdateJob(sql)) return { rowCount: 1 };
      return { rows: [] };
    });
    mockListOrgGoogleAccounts.mockResolvedValue([]);

    const res = await request(app).post("/orgs/google/sync").set(idHeaders).send({});
    expect(res.status).toBe(202);
    expect(res.body.jobId).toBe(TEST_JOB_ID);
    expect(res.body.status).toBe("running");
  });

  it("response returns BEFORE background ingest finishes", async () => {
    let releaseGmail!: () => void;
    const gmailGate = new Promise<void>((resolve) => {
      releaseGmail = resolve;
    });

    mockQuery.mockImplementation(async (sql: string) => {
      if (isInsertJob(sql)) return { rows: [{ id: TEST_JOB_ID }] };
      if (isUpdateJob(sql)) return { rowCount: 1 };
      return { rows: [] };
    });
    mockListOrgGoogleAccounts.mockResolvedValue([acct("a-1")]);
    mockIngestGmail.mockImplementation(async () => {
      await gmailGate;
      return { inserted: 1, updated: 0, unchanged: 0 };
    });
    mockIngestPeople.mockResolvedValue({ inserted: 0, updated: 0, unchanged: 0, deleted: 0 });

    const res = await request(app).post("/orgs/google/sync").set(idHeaders).send({});
    expect(res.status).toBe(202);
    // bg ingest still hung: no UPDATE call yet
    const updateCallsBefore = mockQuery.mock.calls.filter((c) => isUpdateJob(c[0]));
    expect(updateCallsBefore).toHaveLength(0);

    releaseGmail();
    // now wait for bg work to commit final UPDATE
    await vi.waitFor(() => {
      const updateCalls = mockQuery.mock.calls.filter((c) => isUpdateJob(c[0]));
      expect(updateCalls.length).toBeGreaterThan(0);
    });
  });

  it("background work updates job to succeeded with summary on success", async () => {
    const updateCalls: { sql: string; params: unknown[] }[] = [];
    mockQuery.mockImplementation(async (sql: string, params: unknown[]) => {
      if (isInsertJob(sql)) return { rows: [{ id: TEST_JOB_ID }] };
      if (isUpdateJob(sql)) {
        updateCalls.push({ sql, params });
        return { rowCount: 1 };
      }
      return { rows: [] };
    });
    mockListOrgGoogleAccounts.mockResolvedValue([acct("a-1"), acct("a-2")]);
    mockIngestGmail.mockResolvedValue({ inserted: 5, updated: 1, unchanged: 0 });
    mockIngestPeople.mockResolvedValue({ inserted: 3, updated: 0, unchanged: 0, deleted: 0 });

    await request(app).post("/orgs/google/sync").set(idHeaders).send({});

    await vi.waitFor(() => {
      expect(updateCalls.length).toBeGreaterThan(0);
    });
    const last = updateCalls[updateCalls.length - 1];
    expect(last.sql).toMatch(/status\s*=\s*'succeeded'/);
    const summary = last.params.find(
      (p) => typeof p === "object" && p !== null && "accounts" in (p as Record<string, unknown>)
    ) as { accounts: number; gmail: { inserted: number }; contacts: { inserted: number } };
    expect(summary).toBeTruthy();
    expect(summary.accounts).toBe(2);
    expect(summary.gmail.inserted).toBe(10);
    expect(summary.contacts.inserted).toBe(6);
    expect(last.params).toContain(TEST_JOB_ID);
  });

  it("background work updates job to failed with error on ingest throw", async () => {
    const updateCalls: { sql: string; params: unknown[] }[] = [];
    mockQuery.mockImplementation(async (sql: string, params: unknown[]) => {
      if (isInsertJob(sql)) return { rows: [{ id: TEST_JOB_ID }] };
      if (isUpdateJob(sql)) {
        updateCalls.push({ sql, params });
        return { rowCount: 1 };
      }
      return { rows: [] };
    });
    mockListOrgGoogleAccounts.mockResolvedValue([acct("a-1")]);
    mockIngestGmail.mockRejectedValue(new Error("Gmail API 403"));
    mockIngestPeople.mockResolvedValue({ inserted: 0, updated: 0, unchanged: 0, deleted: 0 });

    await request(app).post("/orgs/google/sync").set(idHeaders).send({});

    await vi.waitFor(() => {
      expect(updateCalls.length).toBeGreaterThan(0);
    });
    const last = updateCalls[updateCalls.length - 1];
    expect(last.sql).toMatch(/status\s*=\s*'failed'/);
    expect(last.params.some((p) => typeof p === "string" && p.includes("Gmail API 403"))).toBe(true);
    expect(last.params).toContain(TEST_JOB_ID);
  });

  it("concurrent POSTs return distinct jobIds", async () => {
    const ids = ["00000000-0000-4000-a000-0000000000a1", "00000000-0000-4000-a000-0000000000a2"];
    let i = 0;
    mockQuery.mockImplementation(async (sql: string) => {
      if (isInsertJob(sql)) return { rows: [{ id: ids[i++] }] };
      if (isUpdateJob(sql)) return { rowCount: 1 };
      return { rows: [] };
    });
    mockListOrgGoogleAccounts.mockResolvedValue([]);

    const [r1, r2] = await Promise.all([
      request(app).post("/orgs/google/sync").set(idHeaders).send({}),
      request(app).post("/orgs/google/sync").set(idHeaders).send({}),
    ]);
    expect(r1.status).toBe(202);
    expect(r2.status).toBe(202);
    expect(r1.body.jobId).not.toBe(r2.body.jobId);
  });
});

describe("GET /orgs/google/sync/:jobId", () => {
  it("returns 200 with status=succeeded and summary", async () => {
    const summary = {
      accounts: 1,
      gmail: { inserted: 10, updated: 0, unchanged: 0 },
      contacts: { inserted: 3, updated: 0, unchanged: 0, deleted: 0 },
    };
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: TEST_JOB_ID,
          status: "succeeded",
          summary,
          error: null,
          started_at: new Date("2026-05-09T10:00:00Z"),
          finished_at: new Date("2026-05-09T10:01:30Z"),
        },
      ],
    });

    const res = await request(app)
      .get(`/orgs/google/sync/${TEST_JOB_ID}`)
      .set(idHeaders);
    expect(res.status).toBe(200);
    expect(res.body.jobId).toBe(TEST_JOB_ID);
    expect(res.body.status).toBe("succeeded");
    expect(res.body.summary).toEqual(summary);
    expect(res.body.error).toBeNull();
    expect(res.body.startedAt).toBe("2026-05-09T10:00:00.000Z");
    expect(res.body.finishedAt).toBe("2026-05-09T10:01:30.000Z");
  });

  it("returns 200 with status=failed and error", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: TEST_JOB_ID,
          status: "failed",
          summary: null,
          error: "Gmail API 403 SERVICE_DISABLED",
          started_at: new Date("2026-05-09T10:00:00Z"),
          finished_at: new Date("2026-05-09T10:00:05Z"),
        },
      ],
    });

    const res = await request(app)
      .get(`/orgs/google/sync/${TEST_JOB_ID}`)
      .set(idHeaders);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("failed");
    expect(res.body.error).toBe("Gmail API 403 SERVICE_DISABLED");
    expect(res.body.summary).toBeNull();
  });

  it("returns 200 with status=running while job in flight", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: TEST_JOB_ID,
          status: "running",
          summary: null,
          error: null,
          started_at: new Date("2026-05-09T10:00:00Z"),
          finished_at: null,
        },
      ],
    });

    const res = await request(app)
      .get(`/orgs/google/sync/${TEST_JOB_ID}`)
      .set(idHeaders);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("running");
    expect(res.body.finishedAt).toBeNull();
  });

  it("returns 404 when jobId not found", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get(`/orgs/google/sync/${TEST_JOB_ID}`)
      .set(idHeaders);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it("scopes lookup by org_id (returns 404 for other org's job)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await request(app)
      .get(`/orgs/google/sync/${TEST_JOB_ID}`)
      .set(idHeaders);

    const sql = mockQuery.mock.calls[0][0] as string;
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(sql).toContain("org_id = $1");
    expect(params[0]).toBe(TEST_ORG_ID);
    expect(params[1]).toBe(TEST_JOB_ID);
  });

  it("returns 400 for invalid uuid in :jobId", async () => {
    const res = await request(app)
      .get(`/orgs/google/sync/not-a-uuid`)
      .set(idHeaders);
    expect(res.status).toBe(400);
  });
});

// ─── AC6: read endpoints ───

describe("GET /orgs/google/messages", () => {
  it("returns paginated raw messages with cursor", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: Array.from({ length: 51 }, (_, i) => ({
        id: `00000000-0000-4000-a000-${String(100 + i).padStart(12, "0")}`,
        google_account_id: TEST_ACCOUNT_UUID,
        gmail_message_id: `m-${i}`,
        thread_id: `t-${i}`,
        history_id: 12345 + i,
        payload: { snippet: `hello ${i}` },
        fetched_at: new Date(Date.now() - i * 1000),
      })),
    });

    const res = await request(app).get("/orgs/google/messages?limit=50").set(idHeaders);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(50);
    expect(res.body.items[0].payload.snippet).toBe("hello 0");
    expect(res.body.items[0].historyId).toBe("12345");
    expect(res.body.nextCursor).toBeTruthy();
  });

  it("filters by org_id in SQL", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/orgs/google/messages").set(idHeaders);
    const sql = mockQuery.mock.calls[0][0] as string;
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(sql).toContain("org_id = $1");
    expect(params[0]).toBe(TEST_ORG_ID);
  });

  it("filters by thread_id when provided", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/orgs/google/messages?thread_id=tt-9").set(idHeaders);
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(params).toContain("tt-9");
  });

  it("returns typed silver fields AND legacy fields (incl payload) additively", async () => {
    const sentAt = new Date("2026-05-23T10:00:00.000Z");
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "00000000-0000-4000-a000-000000000100",
          google_account_id: TEST_ACCOUNT_UUID,
          gmail_message_id: "m-1",
          thread_id: "t-1",
          history_id: 999,
          payload: { snippet: "raw payload here" },
          fetched_at: new Date("2026-05-23T11:00:00.000Z"),
          from_email: "grace@navy.mil",
          from_name: "Grace Hopper",
          to_emails: ["a@x.com", "bob@y.com"],
          subject: "Compilers",
          snippet: "hello there",
          sent_at: sentAt,
          labels: ["INBOX"],
          sort_at: sentAt,
        },
      ],
    });

    const res = await request(app).get("/orgs/google/messages").set(idHeaders);
    expect(res.status).toBe(200);
    const item = res.body.items[0];
    // legacy fields preserved
    expect(item.gmailMessageId).toBe("m-1");
    expect(item.historyId).toBe("999");
    expect(item.payload.snippet).toBe("raw payload here");
    expect(item.fetchedAt).toBe("2026-05-23T11:00:00.000Z");
    // typed silver fields (locked contract)
    expect(item.fromEmail).toBe("grace@navy.mil");
    expect(item.fromName).toBe("Grace Hopper");
    expect(item.to).toEqual(["a@x.com", "bob@y.com"]);
    expect(item.subject).toBe("Compilers");
    expect(item.snippet).toBe("hello there");
    expect(item.sentAt).toBe("2026-05-23T10:00:00.000Z");
    expect(item.labels).toEqual(["INBOX"]);
  });

  it("returns null/[] typed fields when silver row absent (LEFT JOIN)", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "00000000-0000-4000-a000-000000000101",
          google_account_id: TEST_ACCOUNT_UUID,
          gmail_message_id: "m-2",
          thread_id: "t-2",
          history_id: 1,
          payload: { snippet: "x" },
          fetched_at: new Date("2026-05-23T11:00:00.000Z"),
          from_email: null,
          from_name: null,
          to_emails: null,
          subject: null,
          snippet: null,
          sent_at: null,
          labels: null,
          sort_at: new Date("2026-05-23T11:00:00.000Z"),
        },
      ],
    });

    const res = await request(app).get("/orgs/google/messages").set(idHeaders);
    const item = res.body.items[0];
    expect(item.fromEmail).toBeNull();
    expect(item.to).toEqual([]);
    expect(item.sentAt).toBeNull();
    expect(item.labels).toEqual([]);
  });

  it("filters by participant email via ILIKE and orders by internalDate DESC", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await request(app)
      .get("/orgs/google/messages?participant=alice%40example.com")
      .set(idHeaders);
    const sql = mockQuery.mock.calls[0][0] as string;
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(sql).toContain("payload::text ILIKE");
    expect(sql).toContain("(m.payload->>'internalDate')::bigint DESC");
    expect(params).toContain("%alice@example.com%");
  });

  it("orders by silver sent_at desc (fallback fetched_at) when participant absent", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/orgs/google/messages").set(idHeaders);
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain("ORDER BY COALESCE(s.sent_at, m.fetched_at) DESC, m.id DESC");
    expect(sql).not.toContain("internalDate");
  });
});

describe("GET /orgs/google/accounts", () => {
  it("rejects missing x-org-id with 400", async () => {
    const res = await request(app)
      .get("/orgs/google/accounts")
      .set({ "x-api-key": "test-google-service-key", "x-user-id": TEST_USER_ID, "x-run-id": TEST_RUN_ID });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("x-org-id");
  });

  it("returns empty list when org has no connected accounts", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get("/orgs/google/accounts").set(idHeaders);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accounts: [] });
  });

  it("returns accounts with mapped fields, scoped to org_id", async () => {
    const connectedAt = new Date("2026-05-01T12:00:00.000Z");
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          google_account_email: "alice@example.com",
          scopes: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/contacts.readonly",
          created_at: connectedAt,
        },
        {
          google_account_email: "bob@example.com",
          scopes: "https://www.googleapis.com/auth/gmail.readonly",
          created_at: new Date("2026-05-02T12:00:00.000Z"),
        },
      ],
    });

    const res = await request(app).get("/orgs/google/accounts").set(idHeaders);
    expect(res.status).toBe(200);
    expect(res.body.accounts).toHaveLength(2);
    expect(res.body.accounts[0]).toEqual({
      email: "alice@example.com",
      status: "active",
      scopes: [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/contacts.readonly",
      ],
      connectedAt: "2026-05-01T12:00:00.000Z",
    });

    const sql = mockQuery.mock.calls[0][0] as string;
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(sql).toContain("WHERE org_id = $1");
    expect(params).toEqual([TEST_ORG_ID]);
  });
});

describe("GET /orgs/google/contacts", () => {
  it("filters by query string via ILIKE on payload::text", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/orgs/google/contacts?query=alice").set(idHeaders);
    const sql = mockQuery.mock.calls[0][0] as string;
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(sql).toContain("ILIKE");
    expect(params).toContain("%alice%");
  });

  it("returns items with raw payloads", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: TEST_ACCOUNT_UUID,
          google_account_id: TEST_ACCOUNT_UUID,
          resource_name: "people/c1",
          etag: "abc",
          payload: { names: [{ displayName: "Alice" }] },
          fetched_at: new Date(),
          linked_org_ids: [],
          linked_brand_ids: [],
          linked_feature_slugs: [],
          link_status: null,
        },
      ],
    });
    const res = await request(app).get("/orgs/google/contacts").set(idHeaders);
    expect(res.status).toBe(200);
    expect(res.body.items[0].resourceName).toBe("people/c1");
    expect(res.body.items[0].payload.names[0].displayName).toBe("Alice");
  });

  it("dedups via ROW_NUMBER window over primary_email in SQL", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await request(app).get("/orgs/google/contacts").set(idHeaders);
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain("ROW_NUMBER()");
    expect(sql).toContain("PARTITION BY COALESCE(lower(s.primary_email), c.resource_name)");
    expect(sql).toContain("LEFT JOIN google_contacts_silver");
    expect(sql).toContain("LEFT JOIN google_contact_links");
  });

  it("returns typed silver fields, links, AND legacy fields (incl payload) additively", async () => {
    const updatedAt = new Date("2026-05-01T00:00:00.000Z");
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: TEST_ACCOUNT_UUID,
          google_account_id: TEST_ACCOUNT_UUID,
          resource_name: "people/c1",
          etag: "abc",
          payload: { names: [{ displayName: "Alice" }] },
          fetched_at: new Date("2026-05-01T01:00:00.000Z"),
          display_name: "Alice Turing",
          primary_email: "alice@x.com",
          emails: ["alice@x.com", "a2@x.com"],
          phones: ["+15550001111"],
          organization: "Bletchley",
          job_title: "Cryptanalyst",
          photo_url: "https://p/alice.jpg",
          silver_updated_at: updatedAt,
          deleted: false,
          linked_org_ids: ["org-1", "org-2"],
          linked_brand_ids: ["brand-9"],
          linked_feature_slugs: ["crm"],
          link_status: "customer",
        },
      ],
    });

    const res = await request(app).get("/orgs/google/contacts").set(idHeaders);
    expect(res.status).toBe(200);
    const item = res.body.items[0];
    // legacy preserved
    expect(item.resourceName).toBe("people/c1");
    expect(item.etag).toBe("abc");
    expect(item.payload.names[0].displayName).toBe("Alice");
    // typed silver (locked contract)
    expect(item.displayName).toBe("Alice Turing");
    expect(item.primaryEmail).toBe("alice@x.com");
    expect(item.emails).toEqual(["alice@x.com", "a2@x.com"]);
    expect(item.phones).toEqual(["+15550001111"]);
    expect(item.organization).toBe("Bletchley");
    expect(item.jobTitle).toBe("Cryptanalyst");
    expect(item.photoUrl).toBe("https://p/alice.jpg");
    expect(item.updatedAt).toBe("2026-05-01T00:00:00.000Z");
    expect(item.deleted).toBe(false);
    // per-contact links (locked contract)
    expect(item.links).toEqual({
      orgIds: ["org-1", "org-2"],
      brandIds: ["brand-9"],
      featureSlugs: ["crm"],
      status: "customer",
    });
  });

  it("returns empty link arrays + null status for a contact with no link row", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: TEST_ACCOUNT_UUID,
          google_account_id: TEST_ACCOUNT_UUID,
          resource_name: "people/c2",
          etag: "def",
          payload: {},
          fetched_at: new Date(),
          linked_org_ids: [],
          linked_brand_ids: [],
          linked_feature_slugs: [],
          link_status: null,
        },
      ],
    });
    const res = await request(app).get("/orgs/google/contacts").set(idHeaders);
    expect(res.body.items[0].links).toEqual({
      orgIds: [],
      brandIds: [],
      featureSlugs: [],
      status: null,
    });
  });
});

describe("PUT /orgs/google/contact-links", () => {
  it("upserts on (org, resourceName) and round-trips the persisted row", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          resource_name: "otherContacts/c123",
          linked_org_ids: ["org-1"],
          linked_brand_ids: ["brand-2"],
          linked_feature_slugs: ["crm"],
          status: "lead",
        },
      ],
    });

    const res = await request(app)
      .put("/orgs/google/contact-links")
      .set(idHeaders)
      .send({
        resourceName: "otherContacts/c123",
        orgIds: ["org-1"],
        brandIds: ["brand-2"],
        featureSlugs: ["crm"],
        status: "lead",
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      resourceName: "otherContacts/c123",
      orgIds: ["org-1"],
      brandIds: ["brand-2"],
      featureSlugs: ["crm"],
      status: "lead",
    });

    const sql = mockQuery.mock.calls[0][0] as string;
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(sql).toContain("INSERT INTO google_contact_links");
    expect(sql).toContain("ON CONFLICT (org_id, resource_name) DO UPDATE");
    expect(params[0]).toBe(TEST_ORG_ID);
    expect(params[1]).toBe("otherContacts/c123");
  });

  it("defaults status to null when omitted", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          resource_name: "people/c9",
          linked_org_ids: [],
          linked_brand_ids: [],
          linked_feature_slugs: [],
          status: null,
        },
      ],
    });

    const res = await request(app)
      .put("/orgs/google/contact-links")
      .set(idHeaders)
      .send({ resourceName: "people/c9", orgIds: [], brandIds: [], featureSlugs: [] });

    expect(res.status).toBe(200);
    expect(res.body.status).toBeNull();
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(params[5]).toBeNull();
  });

  it("rejects missing resourceName with 400", async () => {
    const res = await request(app)
      .put("/orgs/google/contact-links")
      .set(idHeaders)
      .send({ orgIds: [], brandIds: [], featureSlugs: [] });
    expect(res.status).toBe(400);
  });
});

// ─── GET /orgs/google/conversation ───

const b64conv = (t: string) => Buffer.from(t, "utf-8").toString("base64url");

describe("GET /orgs/google/conversation", () => {
  const PROSPECT = "prospect@acme.com";
  const OWNER = "owner@ourbrand.com";

  it("returns the exchange with a prospect, both directions, oldest first, with bodies", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ email: OWNER }] })
      .mockResolvedValueOnce({ rows: [{ thread_id: "t1" }] })
      .mockResolvedValueOnce({
        rows: [
          {
            gmail_message_id: "m2",
            thread_id: "t1",
            payload: { payload: { mimeType: "text/plain", body: { data: b64conv("Yes, send the deck.") } } },
            fetched_at: new Date("2026-01-02T00:00:00Z"),
            from_email: PROSPECT,
            from_name: "Prospect",
            to_emails: [OWNER],
            subject: "Re: Quick question",
            snippet: "Yes",
            sent_at: new Date("2026-01-02T00:00:00Z"),
            labels: ["INBOX"],
          },
          {
            gmail_message_id: "m1",
            thread_id: "t1",
            payload: { payload: { mimeType: "text/plain", body: { data: b64conv("Are you the right person?") } } },
            fetched_at: new Date("2026-01-01T00:00:00Z"),
            from_email: OWNER,
            from_name: "Owner",
            to_emails: [PROSPECT],
            subject: "Quick question",
            snippet: "Are you",
            sent_at: new Date("2026-01-01T00:00:00Z"),
            labels: ["SENT"],
          },
        ],
      });

    const res = await request(app)
      .get("/orgs/google/conversation")
      .query({ email: PROSPECT })
      .set(idHeaders);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.threadCount).toBe(1);
    expect(res.body.messageCount).toBe(2);
    const msgs = res.body.threads[0].messages;
    expect(msgs.map((m: { gmailMessageId: string }) => m.gmailMessageId)).toEqual(["m1", "m2"]);
    expect(msgs.map((m: { direction: string }) => m.direction)).toEqual(["outbound", "inbound"]);
    expect(msgs[1].bodyText).toBe("Yes, send the deck.");
  });

  it("scopes the read to the caller's org", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ email: OWNER }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await request(app).get("/orgs/google/conversation").query({ email: PROSPECT }).set(idHeaders);

    for (const call of mockQuery.mock.calls) {
      expect(call[0]).toContain("org_id = $1");
      expect((call[1] as unknown[])[0]).toBe(TEST_ORG_ID);
    }
  });

  it("404s with reason=no_messages when nobody has this exchange", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ email: OWNER }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get("/orgs/google/conversation")
      .query({ email: PROSPECT })
      .set(idHeaders);

    expect(res.status).toBe(404);
    expect(res.body.reason).toBe("no_messages");
  });

  it("404s with reason=no_google_account_connected when the org connected no mailbox", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get("/orgs/google/conversation")
      .query({ email: PROSPECT })
      .set(idHeaders);

    expect(res.status).toBe(404);
    expect(res.body.reason).toBe("no_google_account_connected");
  });

  it("answers 200 status=unreadable (never an empty conversation) when bodies cannot be read", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ email: OWNER }] })
      .mockResolvedValueOnce({ rows: [{ thread_id: "t1" }] })
      .mockResolvedValueOnce({
        rows: [
          {
            gmail_message_id: "m1",
            thread_id: "t1",
            payload: { payload: { mimeType: "text/plain", body: { attachmentId: "att-1" } } },
            fetched_at: new Date("2026-01-01T00:00:00Z"),
            from_email: PROSPECT,
            from_name: null,
            to_emails: [OWNER],
            subject: "Re: Quick question",
            snippet: "…",
            sent_at: new Date("2026-01-01T00:00:00Z"),
            labels: ["INBOX"],
          },
        ],
      });

    const res = await request(app)
      .get("/orgs/google/conversation")
      .query({ email: PROSPECT })
      .set(idHeaders);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("unreadable");
    expect(res.body.messageCount).toBe(1);
    expect(res.body.threads[0].messages[0].bodyStatus).toBe("unavailable");
  });

  it("rejects a request with no email", async () => {
    const res = await request(app).get("/orgs/google/conversation").set(idHeaders);
    expect(res.status).toBe(400);
  });

  it("requires identity headers", async () => {
    const res = await request(app)
      .get("/orgs/google/conversation")
      .query({ email: PROSPECT })
      .set({ "x-api-key": "test-google-service-key", "x-user-id": TEST_USER_ID, "x-run-id": TEST_RUN_ID });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("x-org-id");
  });
});
