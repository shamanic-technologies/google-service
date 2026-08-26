import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockQuery,
  mockGetRefreshToken,
  mockGetGoogleCredentials,
  mockGetCustomer,
  mockGetCampaignSpendByDay,
  mockCreateRun,
  mockAddCosts,
  mockUpdateRun,
} = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockGetRefreshToken: vi.fn(),
  mockGetGoogleCredentials: vi.fn(),
  mockGetCustomer: vi.fn(),
  mockGetCampaignSpendByDay: vi.fn(),
  mockCreateRun: vi.fn(),
  mockAddCosts: vi.fn(),
  mockUpdateRun: vi.fn(),
}));

vi.mock("../env", () => ({
  env: {
    GOOGLE_ADS_SPEND_INTERVAL_HOURS: 12,
    GOOGLE_ADS_SPEND_LOOKBACK_DAYS: 7,
  },
}));

vi.mock("../db/client", () => ({
  pool: { query: vi.fn() },
  query: (...args: unknown[]) => mockQuery(...args),
}));

vi.mock("../services/key-service", () => ({
  getRefreshToken: (...args: unknown[]) => mockGetRefreshToken(...args),
  getGoogleCredentials: (...args: unknown[]) => mockGetGoogleCredentials(...args),
}));

vi.mock("../services/google-ads", () => ({
  createGoogleAdsClient: () => ({}),
  getCustomer: (...args: unknown[]) => mockGetCustomer(...args),
  getCampaignSpendByDay: (...args: unknown[]) => mockGetCampaignSpendByDay(...args),
}));

vi.mock("../services/runs-service", () => ({
  createRun: (...args: unknown[]) => mockCreateRun(...args),
  addCosts: (...args: unknown[]) => mockAddCosts(...args),
  updateRun: (...args: unknown[]) => mockUpdateRun(...args),
}));

import {
  ingestSpendForAccount,
  runSpendIngestOnce,
  microsToCents,
  isoDay,
  GOOGLE_ADS_SPEND_COST_NAME,
} from "../services/spend-ingest";

const ACCOUNT = { orgId: "org-1", userId: "user-1", accountId: "1234567890" };
const NOW = new Date("2026-08-26T09:00:00Z");
const RUN_ID = "00000000-0000-4000-a000-0000000000aa";

/** Upsert returns the previously declared cents for that (campaign, day). */
const upsertReturning = (declaredCents: number, id = "row-1") => ({
  rows: [{ id, declared_cents: declaredCents }],
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  mockGetRefreshToken.mockResolvedValue("refresh-token");
  mockGetGoogleCredentials.mockResolvedValue({
    clientId: "cid",
    clientSecret: "secret",
    developerToken: "dev",
    mccAccountId: "999",
  });
  mockGetCustomer.mockReturnValue({ credentials: { customer_id: ACCOUNT.accountId } });
  mockCreateRun.mockResolvedValue(RUN_ID);
  mockAddCosts.mockResolvedValue(undefined);
  mockUpdateRun.mockResolvedValue(undefined);
});

describe("microsToCents", () => {
  it("converts micros to USD cents", () => {
    expect(microsToCents("1230000")).toBe(123);
    expect(microsToCents(0)).toBe(0);
    expect(microsToCents("15000")).toBe(2); // rounds to nearest cent
  });
});

describe("isoDay", () => {
  it("returns the UTC day, n days back", () => {
    expect(isoDay(NOW)).toBe("2026-08-26");
    expect(isoDay(NOW, 6)).toBe("2026-08-20");
  });
});

describe("ingestSpendForAccount", () => {
  it("declares the observed cents as an org cost, dated by Google's day", async () => {
    mockGetCampaignSpendByDay.mockResolvedValue([
      { campaignId: "c1", date: "2026-08-24", costMicros: "12340000" },
    ]);
    mockQuery
      .mockResolvedValueOnce(upsertReturning(0)) // upsert
      .mockResolvedValueOnce({ rows: [] }); // declared_cents update

    const summary = await ingestSpendForAccount(ACCOUNT, NOW);

    // Window read is the lookback, ending today.
    expect(mockGetCampaignSpendByDay).toHaveBeenCalledWith(
      expect.anything(),
      "2026-08-20",
      "2026-08-26"
    );

    // Run is keyed on GOOGLE's spend day, not on the poll day.
    expect(mockCreateRun).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-1",
        userId: "user-1",
        taskName: "google-ads-spend:2026-08-24",
        idempotencyKey: "google-ads-spend:org-1:1234567890:2026-08-24",
      })
    );

    // PASS-THROUGH: quantity is exactly the cents Google charged, no markup.
    expect(mockAddCosts).toHaveBeenCalledWith(
      RUN_ID,
      [
        {
          costName: GOOGLE_ADS_SPEND_COST_NAME,
          quantity: 1234,
          costSource: "platform",
          idempotencyKey: "c1:1234",
        },
      ],
      "org-1",
      "user-1"
    );
    expect(summary).toEqual({
      accountId: "1234567890",
      daysRead: 1,
      daysDeclared: 1,
      centsDeclared: 1234,
    });
  });

  it("declares only the delta when Google restates a day upward", async () => {
    mockGetCampaignSpendByDay.mockResolvedValue([
      { campaignId: "c1", date: "2026-08-24", costMicros: "20000000" },
    ]);
    mockQuery
      .mockResolvedValueOnce(upsertReturning(1234))
      .mockResolvedValueOnce({ rows: [] });

    const summary = await ingestSpendForAccount(ACCOUNT, NOW);

    expect(mockAddCosts.mock.calls[0][1]).toEqual([
      {
        costName: GOOGLE_ADS_SPEND_COST_NAME,
        quantity: 766,
        costSource: "platform",
        idempotencyKey: "c1:2000",
      },
    ]);
    expect(summary.centsDeclared).toBe(766);
  });

  it("declares nothing when the day is already fully declared", async () => {
    mockGetCampaignSpendByDay.mockResolvedValue([
      { campaignId: "c1", date: "2026-08-24", costMicros: "12340000" },
    ]);
    mockQuery.mockResolvedValueOnce(upsertReturning(1234));

    const summary = await ingestSpendForAccount(ACCOUNT, NOW);

    expect(mockCreateRun).not.toHaveBeenCalled();
    expect(mockAddCosts).not.toHaveBeenCalled();
    expect(summary.daysDeclared).toBe(0);
  });

  it("keeps declared cents on a downward restatement and warns", async () => {
    mockGetCampaignSpendByDay.mockResolvedValue([
      { campaignId: "c1", date: "2026-08-24", costMicros: "5000000" },
    ]);
    mockQuery.mockResolvedValueOnce(upsertReturning(1234));

    const summary = await ingestSpendForAccount(ACCOUNT, NOW);

    expect(mockAddCosts).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
    expect(summary.centsDeclared).toBe(0);
  });

  it("shares one run across every campaign that spent on the same day", async () => {
    mockGetCampaignSpendByDay.mockResolvedValue([
      { campaignId: "c1", date: "2026-08-24", costMicros: "1000000" },
      { campaignId: "c2", date: "2026-08-24", costMicros: "2000000" },
      { campaignId: "c1", date: "2026-08-25", costMicros: "3000000" },
    ]);
    mockQuery.mockResolvedValue(upsertReturning(0));
    mockCreateRun
      .mockResolvedValueOnce("run-24")
      .mockResolvedValueOnce("run-25");

    await ingestSpendForAccount(ACCOUNT, NOW);

    expect(mockCreateRun).toHaveBeenCalledTimes(2);
    expect(mockAddCosts.mock.calls.map((c) => c[0])).toEqual([
      "run-24",
      "run-24",
      "run-25",
    ]);
  });

  it("fails loud when the cost cannot be declared — never records it as declared", async () => {
    mockGetCampaignSpendByDay.mockResolvedValue([
      { campaignId: "c1", date: "2026-08-24", costMicros: "12340000" },
    ]);
    mockQuery.mockResolvedValue(upsertReturning(0));
    mockAddCosts.mockRejectedValueOnce(new Error("runs-service down"));

    await expect(ingestSpendForAccount(ACCOUNT, NOW)).rejects.toThrow("runs-service down");
    // Only the upsert ran; declared_cents was never advanced.
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("fails loud when the spend read fails — an unread figure is not zero", async () => {
    mockGetCampaignSpendByDay.mockRejectedValueOnce(new Error("GAQL 500"));
    await expect(ingestSpendForAccount(ACCOUNT, NOW)).rejects.toThrow("GAQL 500");
    expect(mockAddCosts).not.toHaveBeenCalled();
  });
});

describe("runSpendIngestOnce", () => {
  it("isolates a failing account — the rest still ingest", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { org_id: "org-1", user_id: "user-1", account_id: "acc-1" },
        { org_id: "org-2", user_id: "user-2", account_id: "acc-2" },
      ],
    });
    mockGetCampaignSpendByDay
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce([]);

    await expect(runSpendIngestOnce(NOW)).resolves.toBeUndefined();
    expect(mockGetCampaignSpendByDay).toHaveBeenCalledTimes(2);
  });

  it("no-ops when no account is linked", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await runSpendIngestOnce(NOW);
    expect(mockGetCampaignSpendByDay).not.toHaveBeenCalled();
  });
});
