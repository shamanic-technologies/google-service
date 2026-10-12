import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockQuery, mockSyncOrg, mockIngestGmail, mockListDelta } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockSyncOrg: vi.fn(),
  mockIngestGmail: vi.fn(),
  mockListDelta: vi.fn(),
}));

vi.mock("../env", () => ({
  env: { GOOGLE_SYNC_INTERVAL_HOURS: 6, GOOGLE_GMAIL_FRESH_INTERVAL_MINUTES: 15 },
}));

vi.mock("../services/gmail-ingest", () => ({
  ingestGmailForAccount: (...args: unknown[]) => mockIngestGmail(...args),
}));

vi.mock("../services/google-tokens", () => ({
  listGmailDeltaAccounts: (...args: unknown[]) => mockListDelta(...args),
}));

vi.mock("../db/client", () => ({
  pool: { query: vi.fn() },
  query: (...args: unknown[]) => mockQuery(...args),
}));

vi.mock("../services/sync", () => ({
  syncOrg: (...args: unknown[]) => mockSyncOrg(...args),
}));

import { runAutoSyncOnce, runGmailFreshOnce, startGmailFreshSync } from "../services/cron-sync";

const summary = {
  accounts: 1,
  gmail: { inserted: 0, updated: 0, unchanged: 0 },
  contacts: { inserted: 0, updated: 0, unchanged: 0, deleted: 0 },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("runAutoSyncOnce", () => {
  it("syncs every distinct org with the CRON caller and no run id", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ org_id: "org-a" }, { org_id: "org-b" }],
    });
    mockSyncOrg.mockResolvedValue(summary);

    await runAutoSyncOnce();

    const selectSql = mockQuery.mock.calls[0][0] as string;
    expect(selectSql).toContain("SELECT DISTINCT org_id FROM google_oauth_tokens");
    expect(mockSyncOrg).toHaveBeenCalledTimes(2);
    expect(mockSyncOrg).toHaveBeenCalledWith(
      "org-a",
      expect.objectContaining({ method: "CRON" })
    );
    // no run id / feature / brand forwarded on the cron path
    expect(mockSyncOrg.mock.calls[0]).toHaveLength(2);
  });

  it("isolates a failing org — the rest still sync", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ org_id: "org-a" }, { org_id: "org-b" }],
    });
    mockSyncOrg
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(summary);

    await expect(runAutoSyncOnce()).resolves.toBeUndefined();
    expect(mockSyncOrg).toHaveBeenCalledTimes(2);
  });

  it("no-ops when no org has connected accounts", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await runAutoSyncOnce();
    expect(mockSyncOrg).not.toHaveBeenCalled();
  });
});

const account = (id: string, orgId: string) => ({ id, orgId, gmailHistoryId: "100" });
const gmailResult = { inserted: 0, updated: 0, unchanged: 0 };

describe("runGmailFreshOnce", () => {
  it("runs a Gmail-only ingest for every caught-up account, never People", async () => {
    mockListDelta.mockResolvedValueOnce([account("a1", "org-a"), account("b1", "org-b")]);
    mockIngestGmail.mockResolvedValue(gmailResult);

    await runGmailFreshOnce();

    expect(mockIngestGmail).toHaveBeenCalledTimes(2);
    expect(mockIngestGmail.mock.calls[0][0]).toMatchObject({ id: "a1", orgId: "org-a" });
    expect(mockIngestGmail.mock.calls[0][1]).toMatchObject({ method: "CRON", path: "/cron/gmail-fresh" });
    expect(mockSyncOrg).not.toHaveBeenCalled();
  });

  it("isolates a failing account and logs it loudly", async () => {
    mockListDelta.mockResolvedValueOnce([account("a1", "org-a"), account("b1", "org-b")]);
    mockIngestGmail.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(gmailResult);

    await expect(runGmailFreshOnce()).resolves.toBeUndefined();
    expect(mockIngestGmail).toHaveBeenCalledTimes(2);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("gmail-fresh failed for org=org-a"));
  });
});

describe("startGmailFreshSync", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("first tick ~60s after boot, next one an interval after the previous FINISHED", async () => {
    mockListDelta.mockResolvedValue([]);
    startGmailFreshSync();

    await vi.advanceTimersByTimeAsync(59_000);
    expect(mockListDelta).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mockListDelta).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(15 * 60 * 1000 - 1);
    expect(mockListDelta).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mockListDelta).toHaveBeenCalledTimes(2);
  });

  it("never overlaps: a slow pass delays the next tick", async () => {
    let release!: () => void;
    mockListDelta.mockImplementationOnce(() => new Promise((r) => { release = () => r([]); }));
    mockListDelta.mockResolvedValue([]);
    startGmailFreshSync();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockListDelta).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(40 * 60 * 1000);
    expect(mockListDelta).toHaveBeenCalledTimes(1);

    release();
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(mockListDelta).toHaveBeenCalledTimes(2);
  });
});
