import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  mockQuery,
  mockListOtherContacts,
  mockEnsureFreshAccessToken,
  mockUpdateOtherContactsSyncToken,
  mockClearOtherContactsSyncToken,
} = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockListOtherContacts: vi.fn(),
  mockEnsureFreshAccessToken: vi.fn(),
  mockUpdateOtherContactsSyncToken: vi.fn(),
  mockClearOtherContactsSyncToken: vi.fn(),
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

vi.mock("../services/google-api", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../services/google-api");
  return {
    ...actual,
    listOtherContacts: (...args: unknown[]) => mockListOtherContacts(...args),
  };
});

vi.mock("../services/google-tokens", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../services/google-tokens");
  return {
    ...actual,
    ensureFreshAccessToken: (...args: unknown[]) => mockEnsureFreshAccessToken(...args),
    updateOtherContactsSyncToken: (...args: unknown[]) =>
      mockUpdateOtherContactsSyncToken(...args),
    clearOtherContactsSyncToken: (...args: unknown[]) =>
      mockClearOtherContactsSyncToken(...args),
  };
});

import { ingestOtherPeopleForAccount } from "../services/people-ingest";
import { GoogleApiError } from "../services/google-api";
import type { GoogleAccountToken } from "../services/google-tokens";

const TEST_ORG_ID = "00000000-0000-4000-a000-000000000001";
const TEST_ACCOUNT_ID = "00000000-0000-4000-a000-000000000099";
const TEST_RUN_ID = "00000000-0000-4000-a000-000000000003";

const OTHER_SCOPE = "https://www.googleapis.com/auth/contacts.other.readonly";

const makeAccount = (overrides: Partial<GoogleAccountToken> = {}): GoogleAccountToken => ({
  id: TEST_ACCOUNT_ID,
  orgId: TEST_ORG_ID,
  userId: "00000000-0000-4000-a000-000000000002",
  googleAccountEmail: "alice@example.com",
  refreshToken: "rt",
  accessToken: "at",
  accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
  scopes: `https://www.googleapis.com/auth/gmail.readonly ${OTHER_SCOPE}`,
  gmailHistoryId: null,
  peopleSyncToken: null,
  otherContactsSyncToken: null,
  ...overrides,
});

const caller = { method: "POST", path: "/orgs/google/sync" };

beforeEach(() => {
  vi.clearAllMocks();
  mockEnsureFreshAccessToken.mockResolvedValue("fresh-access-token");
  mockUpdateOtherContactsSyncToken.mockResolvedValue(undefined);
  mockClearOtherContactsSyncToken.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ingestOtherPeopleForAccount", () => {
  it("success path: upserts each contact and persists syncToken", async () => {
    mockListOtherContacts.mockResolvedValueOnce({
      otherContacts: [
        { resourceName: "otherContacts/c1", etag: "e1" },
        { resourceName: "otherContacts/c2", etag: "e2" },
      ],
      nextSyncToken: "next-sync-tok",
    });
    // upsertContact returns one row with inserted=true for each call
    mockQuery.mockResolvedValue({ rows: [{ inserted: true }], rowCount: 1 });

    const result = await ingestOtherPeopleForAccount(
      makeAccount(),
      caller,
      TEST_RUN_ID,
      undefined,
      undefined
    );

    expect(result.inserted).toBe(2);
    expect(result.updated).toBe(0);
    expect(result.unchanged).toBe(0);
    expect(result.deleted).toBe(0);

    expect(mockListOtherContacts).toHaveBeenCalledTimes(1);
    expect(mockListOtherContacts).toHaveBeenCalledWith(
      "fresh-access-token",
      expect.objectContaining({
        pageSize: 1000,
        requestSyncToken: true,
        syncToken: undefined,
      })
    );
    expect(mockUpdateOtherContactsSyncToken).toHaveBeenCalledWith(
      TEST_ORG_ID,
      TEST_ACCOUNT_ID,
      "next-sync-tok"
    );
  });

  it("empty page: zero counts, no upsert, syncToken still stored", async () => {
    mockListOtherContacts.mockResolvedValueOnce({
      otherContacts: [],
      nextSyncToken: "tok-empty",
    });

    const result = await ingestOtherPeopleForAccount(
      makeAccount(),
      caller,
      TEST_RUN_ID,
      undefined,
      undefined
    );

    expect(result).toEqual({ inserted: 0, updated: 0, unchanged: 0, deleted: 0 });
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockUpdateOtherContactsSyncToken).toHaveBeenCalledWith(
      TEST_ORG_ID,
      TEST_ACCOUNT_ID,
      "tok-empty"
    );
  });

  it("scope-missing: warns and returns zero without calling Google API", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await ingestOtherPeopleForAccount(
      makeAccount({ scopes: "https://www.googleapis.com/auth/gmail.readonly" }),
      caller,
      TEST_RUN_ID,
      undefined,
      undefined
    );

    expect(result).toEqual({ inserted: 0, updated: 0, unchanged: 0, deleted: 0 });
    expect(mockListOtherContacts).not.toHaveBeenCalled();
    expect(mockEnsureFreshAccessToken).not.toHaveBeenCalled();
    expect(mockUpdateOtherContactsSyncToken).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain(OTHER_SCOPE);
    expect(warnSpy.mock.calls[0][0]).toMatch(/\[google-service\]/);
  });

  it("multi-page (>1000 contacts): requestSyncToken stays true on every page, no 400", async () => {
    // Page 1 returns a nextPageToken (i.e. account has >1000 contacts spanning
    // multiple pages). Page 2 is the final page and carries nextSyncToken.
    mockListOtherContacts
      .mockResolvedValueOnce({
        otherContacts: [{ resourceName: "otherContacts/c1", etag: "e1" }],
        nextPageToken: "page-2-token",
      })
      .mockResolvedValueOnce({
        otherContacts: [{ resourceName: "otherContacts/c2", etag: "e2" }],
        nextSyncToken: "final-sync-tok",
      });
    mockQuery.mockResolvedValue({ rows: [{ inserted: true }], rowCount: 1 });

    const result = await ingestOtherPeopleForAccount(
      makeAccount(),
      caller,
      TEST_RUN_ID,
      undefined,
      undefined
    );

    expect(result.inserted).toBe(2);
    expect(mockListOtherContacts).toHaveBeenCalledTimes(2);

    // Page 1: no pageToken, requestSyncToken true.
    expect(mockListOtherContacts.mock.calls[0][1]).toMatchObject({
      pageToken: undefined,
      requestSyncToken: true,
    });
    // Page 2: has pageToken, requestSyncToken STILL true (the bug set it to
    // false here, which Google 400s). syncToken remains undefined (exempt param).
    expect(mockListOtherContacts.mock.calls[1][1]).toMatchObject({
      pageToken: "page-2-token",
      requestSyncToken: true,
    });

    // requestSyncToken must be constant across all pages.
    const flags = mockListOtherContacts.mock.calls.map((c) => c[1].requestSyncToken);
    expect(new Set(flags)).toEqual(new Set([true]));

    expect(mockUpdateOtherContactsSyncToken).toHaveBeenCalledWith(
      TEST_ORG_ID,
      TEST_ACCOUNT_ID,
      "final-sync-tok"
    );
  });

  it("delta path: passes stored syncToken on first page when present", async () => {
    mockListOtherContacts.mockResolvedValueOnce({
      otherContacts: [],
      nextSyncToken: "tok-new",
    });

    await ingestOtherPeopleForAccount(
      makeAccount({ otherContactsSyncToken: "tok-prev" }),
      caller,
      TEST_RUN_ID,
      undefined,
      undefined
    );

    expect(mockListOtherContacts).toHaveBeenCalledWith(
      "fresh-access-token",
      expect.objectContaining({
        syncToken: "tok-prev",
        requestSyncToken: true,
      })
    );
  });

  it("expired sync token: clears stored token and retries a full list once", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // First list (with the stored syncToken) fails EXPIRED_SYNC_TOKEN; the full
    // re-list (no syncToken) then succeeds.
    mockListOtherContacts
      .mockRejectedValueOnce(
        new GoogleApiError(
          400,
          "https://people/otherContacts",
          '{"error":{"status":"FAILED_PRECONDITION","message":"Sync token is expired.","details":[{"reason":"EXPIRED_SYNC_TOKEN"}]}}'
        )
      )
      .mockResolvedValueOnce({
        otherContacts: [{ resourceName: "otherContacts/c1", etag: "e1" }],
        nextSyncToken: "fresh-tok",
      });
    mockQuery.mockResolvedValue({ rows: [{ inserted: true }], rowCount: 1 });

    const result = await ingestOtherPeopleForAccount(
      makeAccount({ otherContactsSyncToken: "stale-tok" }),
      caller,
      TEST_RUN_ID,
      undefined,
      undefined
    );

    expect(result.inserted).toBe(1);
    expect(mockClearOtherContactsSyncToken).toHaveBeenCalledWith(
      TEST_ORG_ID,
      TEST_ACCOUNT_ID
    );
    expect(mockListOtherContacts).toHaveBeenCalledTimes(2);
    // Retry #2 runs a FULL list — no syncToken.
    expect(mockListOtherContacts.mock.calls[1][1]).toMatchObject({
      syncToken: undefined,
      requestSyncToken: true,
    });
    // The fresh sync token from the recovered full list is persisted.
    expect(mockUpdateOtherContactsSyncToken).toHaveBeenCalledWith(
      TEST_ORG_ID,
      TEST_ACCOUNT_ID,
      "fresh-tok"
    );
    warnSpy.mockRestore();
  });

  it("non-expired 400 error propagates (no clear, no retry)", async () => {
    mockListOtherContacts.mockRejectedValueOnce(
      new GoogleApiError(400, "https://people/otherContacts", "INVALID_ARGUMENT")
    );

    await expect(
      ingestOtherPeopleForAccount(
        makeAccount({ otherContactsSyncToken: "stale-tok" }),
        caller,
        TEST_RUN_ID,
        undefined,
        undefined
      )
    ).rejects.toThrow(/400/);

    expect(mockClearOtherContactsSyncToken).not.toHaveBeenCalled();
    expect(mockListOtherContacts).toHaveBeenCalledTimes(1);
  });
});
