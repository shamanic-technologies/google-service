import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));

vi.mock("../env", () => ({
  env: {
    PORT: 8080,
    GOOGLE_SERVICE_DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    GOOGLE_SERVICE_API_KEY: "test-google-service-key",
    RUNS_SERVICE_URL: "http://localhost:3002",
    RUNS_SERVICE_API_KEY: "test-runs-service-key",
  },
}));

vi.mock("../db/client", () => ({
  pool: { query: vi.fn() },
  query: (...args: unknown[]) => mockQuery(...args),
}));

vi.mock("../services/runs-service", () => ({
  createRun: vi.fn().mockResolvedValue("bbbbbbbb-1111-4111-8111-000000000009"),
  updateRun: vi.fn().mockResolvedValue(undefined),
}));

import { listCorrespondents } from "../services/correspondents";
import { createApp } from "../app";

const app = createApp();

const ORG = "bbbbbbbb-1111-4111-8111-000000000001";
const OWNER = "owner@gmail.com";
const ALIAS = "owner@ourbrand.com";

const row = (over: Record<string, unknown>) => ({
  addr: "prospect@acme.com",
  out_n: 2,
  in_n: 1,
  last_out: new Date("2026-01-02T00:00:00Z"),
  last_in: new Date("2026-01-03T00:00:00Z"),
  first_at: new Date("2026-01-01T00:00:00Z"),
  last_at: new Date("2026-01-03T00:00:00Z"),
  msg_name: "Pat Prospect",
  contact_name: "Pat P.",
  total: 2,
  two_way_total: 1,
  ...over,
});

beforeEach(() => {
  mockQuery.mockReset();
});

describe("listCorrespondents", () => {
  it("answers not connected (never an empty list) when the org has no mailbox", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await listCorrespondents(ORG);

    expect(res).toEqual({ connected: false, reason: "no_google_account_connected" });
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("answers connected with total 0 when the owner wrote to nobody", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ email: OWNER }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await listCorrespondents(ORG);

    expect(res).toEqual({
      connected: true,
      page: { ownerAddresses: [OWNER], total: 0, twoWayTotal: 0, limit: 500, offset: 0, correspondents: [] },
    });
  });

  it("treats senders of SENT mail as owner addresses and excludes them as correspondents", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ email: OWNER }] })
      .mockResolvedValueOnce({ rows: [{ email: ALIAS }, { email: OWNER }] })
      .mockResolvedValueOnce({ rows: [row({})] });

    const res = await listCorrespondents(ORG);

    if (!res.connected) throw new Error("expected connected");
    expect(res.page.ownerAddresses).toEqual([OWNER, ALIAS]);
    const params = mockQuery.mock.calls[2][1] as unknown[];
    expect(params[1]).toEqual([OWNER, ALIAS]);
    const sql = mockQuery.mock.calls[2][0] as string;
    // the owner's own addresses are excluded from the recipients
    expect(sql).toContain("NOT (r.addr = ANY($2::text[]))");
  });

  it("shapes each correspondent with counts each way, activity dates and a sourced name", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ email: OWNER }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          row({}),
          row({
            addr: "silent@acme.com",
            out_n: 1,
            in_n: 0,
            last_in: null,
            last_at: new Date("2026-01-02T00:00:00Z"),
            msg_name: null,
            contact_name: "Silent Sam",
          }),
        ],
      });

    const res = await listCorrespondents(ORG);
    if (!res.connected) throw new Error("expected connected");

    expect(res.page.total).toBe(2);
    expect(res.page.twoWayTotal).toBe(1);
    expect(res.page.correspondents).toEqual([
      {
        email: "prospect@acme.com",
        name: "Pat Prospect",
        nameSource: "message",
        outboundMessages: 2,
        inboundMessages: 1,
        twoWay: true,
        firstMessageAt: "2026-01-01T00:00:00.000Z",
        lastMessageAt: "2026-01-03T00:00:00.000Z",
        lastOutboundAt: "2026-01-02T00:00:00.000Z",
        lastInboundAt: "2026-01-03T00:00:00.000Z",
      },
      {
        email: "silent@acme.com",
        name: "Silent Sam",
        nameSource: "contact",
        outboundMessages: 1,
        inboundMessages: 0,
        twoWay: false,
        firstMessageAt: "2026-01-01T00:00:00.000Z",
        lastMessageAt: "2026-01-02T00:00:00.000Z",
        lastOutboundAt: "2026-01-02T00:00:00.000Z",
        lastInboundAt: null,
      },
    ]);
  });

  it("scopes every statement to the caller's org and never touches bronze", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ email: OWNER }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [row({})] });

    await listCorrespondents(ORG, { limit: 10, offset: 0 });

    for (const call of mockQuery.mock.calls) {
      expect((call[1] as unknown[])[0]).toBe(ORG);
      expect(call[0] as string).toMatch(/org_id = \$1/);
      expect(call[0] as string).not.toContain("gmail_messages_raw");
    }
  });

  it("orders on a total order so pages never overlap or skip", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ email: OWNER }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [row({})] });

    await listCorrespondents(ORG, { limit: 10, offset: 20 });

    const [sql, params] = mockQuery.mock.calls[2] as [string, unknown[]];
    expect(sql).toContain("ORDER BY j.last_at DESC NULLS LAST, j.addr ASC");
    expect(params.slice(2)).toEqual([10, 20]);
  });

  it("still reports the totals when paged past the end", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ email: OWNER }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 7, two_way_total: 3 }] });

    const res = await listCorrespondents(ORG, { limit: 10, offset: 100 });
    if (!res.connected) throw new Error("expected connected");

    expect(res.page.total).toBe(7);
    expect(res.page.twoWayTotal).toBe(3);
    expect(res.page.correspondents).toEqual([]);
  });
});

describe("GET /orgs/google/correspondents", () => {
  const idHeaders = {
    "x-api-key": "test-google-service-key",
    "x-org-id": ORG,
    "x-user-id": "bbbbbbbb-1111-4111-8111-000000000002",
    "x-run-id": "bbbbbbbb-1111-4111-8111-000000000003",
  };

  it("answers 404 reason=no_google_account_connected when no mailbox is connected", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get("/orgs/google/correspondents").set(idHeaders);

    expect(res.status).toBe(404);
    expect(res.body.reason).toBe("no_google_account_connected");
  });

  it("answers 200 with the page", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ email: OWNER }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [row({ total: 1, two_way_total: 1 })] });

    const res = await request(app).get("/orgs/google/correspondents").query({ limit: 50 }).set(idHeaders);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.limit).toBe(50);
    expect(res.body.correspondents[0].email).toBe("prospect@acme.com");
  });

  it("rejects an out-of-range limit with 400", async () => {
    const res = await request(app).get("/orgs/google/correspondents").query({ limit: 5000 }).set(idHeaders);
    expect(res.status).toBe(400);
  });
});
