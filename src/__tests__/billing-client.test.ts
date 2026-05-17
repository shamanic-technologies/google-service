import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../env", () => ({
  env: {
    BILLING_SERVICE_URL: "http://billing.test",
    BILLING_SERVICE_API_KEY: "test-billing-key",
  },
}));

describe("authorizeCredits", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ sufficient: true, balance_cents: "1000", required_cents: "10" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts to /v1/customer_balance/authorize (not the legacy /v1/credits/authorize)", async () => {
    const { authorizeCredits } = await import("../services/billing-client");
    await authorizeCredits(
      [{ costName: "serper-dev-query", quantity: 1 }],
      "serper-dev-query",
      "org-1",
      "user-1",
      "run-1"
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe("http://billing.test/v1/customer_balance/authorize");
    expect(String(url)).not.toContain("/credits/authorize");

    const opts = init as RequestInit;
    expect(opts.method).toBe("POST");

    const headers = opts.headers as Record<string, string>;
    expect(headers["X-API-Key"]).toBe("test-billing-key");
    expect(headers["x-org-id"]).toBe("org-1");
    expect(headers["x-user-id"]).toBe("user-1");
    expect(headers["x-run-id"]).toBe("run-1");

    const body = JSON.parse(opts.body as string);
    expect(body).toEqual({
      items: [{ costName: "serper-dev-query", quantity: 1 }],
      description: "serper-dev-query",
    });
  });

  it("throws on non-2xx so callers fail loud", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("Not found", { status: 404 }));
    const { authorizeCredits } = await import("../services/billing-client");
    await expect(
      authorizeCredits(
        [{ costName: "serper-dev-query", quantity: 1 }],
        "serper-dev-query",
        "org-1",
        "user-1"
      )
    ).rejects.toThrow(/Billing authorize failed: 404/);
  });
});
