import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  mockQuery,
  mockGetGmailProfile,
  mockListGmailMessages,
  mockGetGmailMessage,
  mockListGmailHistory,
  mockCreateAccessTokenProvider,
  mockUpdateGmailHistoryId,
  mockProviderGet,
  mockProviderForceRefresh,
} = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockGetGmailProfile: vi.fn(),
  mockListGmailMessages: vi.fn(),
  mockGetGmailMessage: vi.fn(),
  mockListGmailHistory: vi.fn(),
  mockCreateAccessTokenProvider: vi.fn(),
  mockUpdateGmailHistoryId: vi.fn(),
  mockProviderGet: vi.fn(),
  mockProviderForceRefresh: vi.fn(),
}));

vi.mock("../env", () => ({
  env: {
    GOOGLE_GMAIL_BACKFILL_DAYS: 365,
  },
}));

vi.mock("../db/client", () => ({
  pool: { query: vi.fn() },
  query: (...args: unknown[]) => mockQuery(...args),
}));

// Keep the real GoogleApiError + withTokenRetry (the code under test), stub the
// bare HTTP fetch wrappers.
vi.mock("../services/google-api", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../services/google-api");
  return {
    ...actual,
    getGmailProfile: (...args: unknown[]) => mockGetGmailProfile(...args),
    listGmailMessages: (...args: unknown[]) => mockListGmailMessages(...args),
    getGmailMessage: (...args: unknown[]) => mockGetGmailMessage(...args),
    listGmailHistory: (...args: unknown[]) => mockListGmailHistory(...args),
  };
});

vi.mock("../services/google-tokens", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../services/google-tokens");
  return {
    ...actual,
    createAccessTokenProvider: (...args: unknown[]) => mockCreateAccessTokenProvider(...args),
    updateGmailHistoryId: (...args: unknown[]) => mockUpdateGmailHistoryId(...args),
  };
});

// Silver projection is exercised by its own suite; stub it here so the gmail
// backfill test stays focused on token refresh + resumability.
vi.mock("../services/silver", () => ({
  parseMessageSilver: () => ({}),
  upsertMessageSilver: vi.fn().mockResolvedValue(undefined),
}));

import { ingestGmailForAccount } from "../services/gmail-ingest";
import { GoogleApiError } from "../services/google-api";
import type { GoogleAccountToken } from "../services/google-tokens";

const TEST_ORG_ID = "00000000-0000-4000-a000-000000000001";
const TEST_ACCOUNT_ID = "00000000-0000-4000-a000-000000000099";
const TEST_RUN_ID = "00000000-0000-4000-a000-000000000003";

const makeAccount = (overrides: Partial<GoogleAccountToken> = {}): GoogleAccountToken => ({
  id: TEST_ACCOUNT_ID,
  orgId: TEST_ORG_ID,
  userId: "00000000-0000-4000-a000-000000000002",
  googleAccountEmail: "alice@example.com",
  refreshToken: "rt",
  accessToken: "at",
  accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
  scopes: "https://www.googleapis.com/auth/gmail.readonly",
  gmailHistoryId: null,
  peopleSyncToken: null,
  otherContactsSyncToken: null,
  ...overrides,
});

const caller = { method: "POST", path: "/orgs/google/sync" };

const makeMessage = (id: string) => ({
  id,
  threadId: `t-${id}`,
  historyId: "5",
  internalDate: "0",
  payload: { headers: [] },
});

// mockQuery routes by SQL: the existing-ids SELECT, the bronze upsert, then silver.
const routeQuery = (existingIds: string[]) =>
  mockQuery.mockImplementation((sql: string) => {
    if (sql.includes("SELECT gmail_message_id")) {
      return Promise.resolve({ rows: existingIds.map((gmail_message_id) => ({ gmail_message_id })) });
    }
    if (sql.includes("INSERT INTO gmail_messages_raw")) {
      return Promise.resolve({ rows: [{ id: "bronze-row", inserted: true }] });
    }
    return Promise.resolve({ rows: [] });
  });

beforeEach(() => {
  vi.clearAllMocks();
  mockProviderGet.mockResolvedValue("token-1");
  mockProviderForceRefresh.mockResolvedValue("token-2");
  mockCreateAccessTokenProvider.mockReturnValue({
    get: mockProviderGet,
    forceRefresh: mockProviderForceRefresh,
  });
  mockUpdateGmailHistoryId.mockResolvedValue(undefined);
  mockGetGmailProfile.mockResolvedValue({ historyId: "999" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ingestGmailForAccount — backfill token refresh mid-loop", () => {
  it("refreshes the access token and retries once when a per-message fetch 401s", async () => {
    routeQuery([]);
    mockListGmailMessages.mockResolvedValueOnce({
      messages: [{ id: "m1", threadId: "t1" }],
    });
    // First getMessage 401s (token aged out mid-backfill); after forceRefresh it
    // succeeds on retry.
    mockGetGmailMessage
      .mockRejectedValueOnce(
        new GoogleApiError(401, "https://gmail/messages/m1", "Invalid Credentials")
      )
      .mockResolvedValueOnce(makeMessage("m1"));

    const result = await ingestGmailForAccount(
      makeAccount(),
      caller,
      TEST_RUN_ID,
      undefined,
      undefined
    );

    expect(result.inserted).toBe(1);
    expect(mockProviderForceRefresh).toHaveBeenCalledTimes(1);
    expect(mockGetGmailMessage).toHaveBeenCalledTimes(2);
    // Retry used the refreshed token.
    expect(mockGetGmailMessage.mock.calls[1][0]).toBe("token-2");
    // History id persisted so the next sync runs a delta.
    expect(mockUpdateGmailHistoryId).toHaveBeenCalledWith(TEST_ORG_ID, TEST_ACCOUNT_ID, "999");
  });

  it("resumes: skips messages already stored, never re-fetching them", async () => {
    routeQuery(["m1"]); // m1 already in bronze from a prior interrupted run
    mockListGmailMessages.mockResolvedValueOnce({
      messages: [
        { id: "m1", threadId: "t1" },
        { id: "m2", threadId: "t2" },
      ],
    });
    mockGetGmailMessage.mockResolvedValueOnce(makeMessage("m2"));

    const result = await ingestGmailForAccount(
      makeAccount(),
      caller,
      TEST_RUN_ID,
      undefined,
      undefined
    );

    expect(result.unchanged).toBe(1); // m1 skipped
    expect(result.inserted).toBe(1); // m2 fetched
    expect(mockGetGmailMessage).toHaveBeenCalledTimes(1);
    expect(mockGetGmailMessage).toHaveBeenCalledWith("token-1", "m2");
  });

  it("propagates a non-401 error (does not retry)", async () => {
    routeQuery([]);
    mockListGmailMessages.mockResolvedValueOnce({ messages: [{ id: "m1", threadId: "t1" }] });
    mockGetGmailMessage.mockRejectedValueOnce(
      new GoogleApiError(500, "https://gmail/messages/m1", "boom")
    );

    await expect(
      ingestGmailForAccount(makeAccount(), caller, TEST_RUN_ID, undefined, undefined)
    ).rejects.toThrow(/500/);
    expect(mockProviderForceRefresh).not.toHaveBeenCalled();
    // A failed backfill must NOT persist the history id (would skip a full backfill).
    expect(mockUpdateGmailHistoryId).not.toHaveBeenCalled();
  });
});
