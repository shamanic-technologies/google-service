import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { requestLogger } from "../middleware/request-logger";

const VALID_ORG = "11111111-1111-1111-1111-111111111111";

function mockReq(path: string, headers: Record<string, string> = {}): Request {
  return { path, method: "GET", headers } as unknown as Request;
}

function mockRes() {
  const handlers: Record<string, () => void> = {};
  const res = {
    statusCode: 400,
    on: (event: string, cb: () => void) => {
      handlers[event] = cb;
      return res;
    },
    finish: () => handlers.finish?.(),
  };
  return res as unknown as Response & { finish: () => void };
}

describe("requestLogger", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let next: NextFunction;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    next = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not log unauthenticated probes (vulnerability scanners)", () => {
    const probes = [
      "/env",
      "/trace",
      "/aws-credentials.json",
      "/.aws/credentials",
      "/docker-compose.yml",
      "/Dockerfile",
      "/info.php",
      "/_profiler",
      "/secrets/gcp.json",
    ];
    for (const path of probes) {
      const res = mockRes();
      requestLogger(mockReq(path), res, next);
      res.finish();
    }
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(probes.length);
  });

  it("logs authenticated requests carrying a valid x-org-id", () => {
    const res = mockRes();
    res.statusCode = 200;
    requestLogger(mockReq("/orgs/google/messages", { "x-org-id": VALID_ORG }), res, next);
    res.finish();
    expect(logSpy).toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it("logs public paths even without identity headers", () => {
    for (const path of ["/health", "/openapi.json"]) {
      const res = mockRes();
      res.statusCode = 200;
      requestLogger(mockReq(path), res, next);
      res.finish();
    }
    expect(logSpy).toHaveBeenCalled();
  });

  it("skips requests with a malformed (non-UUID) x-org-id", () => {
    const res = mockRes();
    requestLogger(mockReq("/orgs/google/messages", { "x-org-id": "not-a-uuid" }), res, next);
    res.finish();
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });
});
