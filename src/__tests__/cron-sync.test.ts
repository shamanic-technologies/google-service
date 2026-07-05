import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockQuery, mockSyncOrg } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockSyncOrg: vi.fn(),
}));

vi.mock("../env", () => ({
  env: { GOOGLE_SYNC_INTERVAL_HOURS: 6 },
}));

vi.mock("../db/client", () => ({
  pool: { query: vi.fn() },
  query: (...args: unknown[]) => mockQuery(...args),
}));

vi.mock("../services/sync", () => ({
  syncOrg: (...args: unknown[]) => mockSyncOrg(...args),
}));

import { runAutoSyncOnce } from "../services/cron-sync";

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
