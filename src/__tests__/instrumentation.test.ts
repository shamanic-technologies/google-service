import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("instrumentation", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.KEY_SERVICE_URL = "http://key.test";
    process.env.KEY_SERVICE_API_KEY = "test-key-service-key";
    process.env.GOOGLE_OAUTH_CLIENT_ID = "client-id-from-env";
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "client-secret-from-env";

    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    );
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it("registers both Google OAuth platform keys at cold start", async () => {
    const { instrument } = await import("../instrumentation");
    await instrument();

    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const urls = fetchSpy.mock.calls.map((call) => call[0]);
    expect(urls).toContain("http://key.test/platform-keys");

    const bodies = fetchSpy.mock.calls.map((call) =>
      JSON.parse((call[1] as RequestInit).body as string)
    );
    const providers = bodies.map((b: { provider: string }) => b.provider);
    expect(providers).toContain("google-oauth-client-id");
    expect(providers).toContain("google-oauth-client-secret");

    const idEntry = bodies.find((b) => b.provider === "google-oauth-client-id");
    const secretEntry = bodies.find((b) => b.provider === "google-oauth-client-secret");
    expect(idEntry.apiKey).toBe("client-id-from-env");
    expect(secretEntry.apiKey).toBe("client-secret-from-env");
  });

  it("skips registration silently when GOOGLE_OAUTH_CLIENT_ID is missing", async () => {
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { instrument } = await import("../instrumentation");
    await expect(instrument()).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("skipping platform key registration"));
  });

  it("throws when key-service registration fails", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("boom", { status: 500 })
    );
    const { instrument } = await import("../instrumentation");
    await expect(instrument()).rejects.toThrow(/Failed to register platform key/);
  });
});
