import { describe, it, expect, vi, afterEach } from "vitest";
import { revokeGoogleToken } from "../services/google-oauth";

const mockFetch = (status: number, body: string) =>
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(body, { status }));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("revokeGoogleToken", () => {
  it("POSTs the token to Google's revoke endpoint and reports revoked on 200", async () => {
    const spy = mockFetch(200, "");
    await expect(revokeGoogleToken("rt-1")).resolves.toBe("revoked");
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://oauth2.googleapis.com/revoke");
    expect(init.method).toBe("POST");
    expect(init.body).toBe("token=rt-1");
    // Egress rule: nothing but the content type goes to Google.
    expect(init.headers).toEqual({ "Content-Type": "application/x-www-form-urlencoded" });
  });

  it("treats 400 invalid_token as already revoked", async () => {
    mockFetch(400, '{"error":"invalid_token","error_description":"Token expired or revoked"}');
    await expect(revokeGoogleToken("rt-1")).resolves.toBe("already_revoked");
  });

  it("throws on any other failure", async () => {
    mockFetch(503, "unavailable");
    await expect(revokeGoogleToken("rt-1")).rejects.toThrow("Google token revoke failed: 503");
  });

  it("throws on a 400 that is not invalid_token", async () => {
    mockFetch(400, '{"error":"invalid_request"}');
    await expect(revokeGoogleToken("rt-1")).rejects.toThrow("400");
  });
});
