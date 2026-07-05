import { describe, it, expect, vi } from "vitest";
import { isTransientConnectError, withConnectRetry } from "../db/retry";

const noSleep = () => Promise.resolve();

describe("isTransientConnectError", () => {
  it("matches transient connect-phase codes", () => {
    for (const code of ["ETIMEDOUT", "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH"]) {
      expect(isTransientConnectError({ code })).toBe(true);
    }
  });

  it("matches pg client connectionTimeoutMillis message", () => {
    expect(isTransientConnectError(new Error("timeout expired"))).toBe(true);
  });

  it("matches pg pool acquire-timeout message (no code)", () => {
    expect(
      isTransientConnectError(new Error("timeout exceeded when trying to connect")),
    ).toBe(true);
  });

  it("does not match SQL / statement-timeout errors", () => {
    expect(isTransientConnectError({ code: "57014" })).toBe(false); // statement timeout
    expect(isTransientConnectError(new Error("syntax error at or near"))).toBe(false);
    expect(isTransientConnectError(null)).toBe(false);
  });
});

describe("withConnectRetry", () => {
  it("returns on first success without retrying", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    await expect(withConnectRetry(fn, { sleep: noSleep })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries a transient error then succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("conn"), { code: "ETIMEDOUT" }))
      .mockResolvedValue("ok");
    await expect(withConnectRetry(fn, { sleep: noSleep })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("propagates a non-transient error immediately", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("syntax error"));
    await expect(withConnectRetry(fn, { sleep: noSleep })).rejects.toThrow("syntax error");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("gives up after the retry budget is exhausted", async () => {
    const err = Object.assign(new Error("cold"), { code: "ETIMEDOUT" });
    const fn = vi.fn().mockRejectedValue(err);
    await expect(
      withConnectRetry(fn, { retries: 2, sleep: noSleep }),
    ).rejects.toThrow("cold");
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });
});
