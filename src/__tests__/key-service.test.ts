import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../env", () => ({
  env: {
    KEY_SERVICE_URL: "http://key.test",
    KEY_SERVICE_API_KEY: "test-key-service-key",
  },
}));

describe("getGoogleOAuthClient", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      if (u.endsWith("/keys/platform/google-client-id/decrypt")) {
        return new Response(JSON.stringify({ key: "client-id-from-store" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.endsWith("/keys/platform/google-client-secret/decrypt")) {
        return new Response(JSON.stringify({ key: "client-secret-from-store" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("provider not found", { status: 404 });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("requests google-client-id + google-client-secret providers (not google-oauth-*)", async () => {
    const { getGoogleOAuthClient } = await import("../services/key-service");
    const result = await getGoogleOAuthClient({ method: "POST", path: "/orgs/google/auth/start" });

    expect(result).toEqual({
      clientId: "client-id-from-store",
      clientSecret: "client-secret-from-store",
    });

    const urls = fetchSpy.mock.calls.map((call) => String(call[0]));
    expect(urls).toContain("http://key.test/keys/platform/google-client-id/decrypt");
    expect(urls).toContain("http://key.test/keys/platform/google-client-secret/decrypt");
    expect(urls).not.toContain("http://key.test/keys/platform/google-oauth-client-id/decrypt");
    expect(urls).not.toContain("http://key.test/keys/platform/google-oauth-client-secret/decrypt");
  });

  it("propagates 404 from key-service as a thrown error", async () => {
    fetchSpy.mockResolvedValue(new Response("provider not found", { status: 404 }));
    const { getGoogleOAuthClient } = await import("../services/key-service");
    await expect(
      getGoogleOAuthClient({ method: "POST", path: "/orgs/google/auth/start" })
    ).rejects.toThrow(/Failed to get platform key/);
  });
});
