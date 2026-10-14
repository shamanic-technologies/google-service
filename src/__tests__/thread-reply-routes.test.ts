import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

const { mockFind, mockReply } = vi.hoisted(() => ({ mockFind: vi.fn(), mockReply: vi.fn() }));

vi.mock("../env", () => ({
  env: {
    PORT: 8080,
    GOOGLE_SERVICE_DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    GOOGLE_SERVICE_API_KEY: "test-google-service-key",
    KEY_SERVICE_URL: "http://localhost:3001",
    KEY_SERVICE_API_KEY: "k",
    RUNS_SERVICE_URL: "http://localhost:3002",
    RUNS_SERVICE_API_KEY: "r",
    BILLING_SERVICE_URL: "http://localhost:3003",
    BILLING_SERVICE_API_KEY: "b",
  },
}));

vi.mock("../db/client", () => ({ pool: { query: vi.fn() }, query: vi.fn() }));

vi.mock("../services/runs-service", () => ({
  createRun: vi.fn().mockResolvedValue("00000000-0000-4000-a000-000000000004"),
  updateRun: vi.fn().mockResolvedValue(undefined),
  addCosts: vi.fn(),
}));

vi.mock("../lib/trace-event", () => ({ traceEvent: vi.fn().mockResolvedValue(undefined) }));

vi.mock("../services/thread-reply", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../services/thread-reply");
  return {
    ...actual,
    findLatestThread: (...args: unknown[]) => mockFind(...args),
    replyInThread: (...args: unknown[]) => mockReply(...args),
  };
});

import { createApp } from "../app";
import { sendPermissionMissing } from "../services/thread-reply";

const app = createApp();
const headers = {
  "x-api-key": "test-google-service-key",
  "x-org-id": "00000000-0000-4000-a000-000000000001",
  "x-user-id": "00000000-0000-4000-a000-000000000002",
  "x-run-id": "00000000-0000-4000-a000-000000000003",
};

beforeEach(() => {
  mockFind.mockReset();
  mockReply.mockReset();
});

describe("GET /orgs/google/threads/latest", () => {
  it("serves the thread", async () => {
    mockFind.mockResolvedValueOnce({ found: true, thread: { threadId: "T1", fromAddress: "a@b.test" } });
    const res = await request(app).get("/orgs/google/threads/latest?email=c@d.test").set(headers);
    expect(res.status).toBe(200);
    expect(res.body.thread.threadId).toBe("T1");
    expect(mockFind).toHaveBeenCalledWith(headers["x-org-id"], "c@d.test");
  });

  it("answers the documented 404 with its reason", async () => {
    mockFind.mockResolvedValueOnce({ found: false, reason: "no_messages" });
    const res = await request(app).get("/orgs/google/threads/latest?email=c@d.test").set(headers);
    expect(res.status).toBe(404);
    expect(res.body.reason).toBe("no_messages");
  });

  it("refuses an address that is not an email", async () => {
    const res = await request(app).get("/orgs/google/threads/latest?email=nope").set(headers);
    expect(res.status).toBe(400);
  });
});

describe("POST /orgs/google/thread-replies", () => {
  const body = { to: "c@d.test", threadId: "T1", bodyHtml: "<p>hi</p>" };

  it("sends and answers the sent message", async () => {
    mockReply.mockResolvedValueOnce({ sent: true, gmailMessageId: "s1", threadId: "T1" });
    const res = await request(app).post("/orgs/google/thread-replies").set(headers).send(body);
    expect(res.status).toBe(200);
    expect(res.body.gmailMessageId).toBe("s1");
  });

  it("round-trips the named refusal (missing send permission) with its sentence", async () => {
    mockReply.mockRejectedValueOnce(sendPermissionMissing("kevin@x.test"));
    const res = await request(app).post("/orgs/google/thread-replies").set(headers).send(body);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("google_send_permission_missing");
    expect(res.body.mailbox).toBe("kevin@x.test");
    expect(res.body.error).toContain("reconnect Google");
  });

  it("refuses a body with no html", async () => {
    const res = await request(app).post("/orgs/google/thread-replies").set(headers).send({ to: "c@d.test", threadId: "T1" });
    expect(res.status).toBe(400);
    expect(mockReply).not.toHaveBeenCalled();
  });
});
