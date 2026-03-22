import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("registerWithApiRegistry", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("skips registration when API_REGISTRY_URL is not set", async () => {
    vi.doMock("../env", () => ({
      env: {
        PORT: 8080,
        DATABASE_URL: "postgresql://test:test@localhost:5432/test",
        GOOGLE_CLIENT_ID: "test-client-id",
        GOOGLE_CLIENT_SECRET: "test-client-secret",
        GOOGLE_DEVELOPER_TOKEN: "test-dev-token",
        GOOGLE_MCC_ACCOUNT_ID: "1234567890",
        KEY_SERVICE_URL: "http://localhost:3001",
        KEY_SERVICE_API_KEY: "test-key",
        RUNS_SERVICE_URL: "http://localhost:3002",
        RUNS_SERVICE_API_KEY: "test-runs-key",
        // API_REGISTRY_URL and API_REGISTRY_API_KEY intentionally omitted
      },
    }));

    const { registerWithServices } = await import("../instrumentation");
    mockFetch.mockResolvedValue({ ok: true });

    await registerWithServices();

    // Should only call fetch for key-service secret registration, not API registry
    for (const call of mockFetch.mock.calls) {
      expect(call[0]).not.toContain("api-registry");
    }
  });

  it("registers when API_REGISTRY_URL is set", async () => {
    vi.doMock("../env", () => ({
      env: {
        PORT: 8080,
        DATABASE_URL: "postgresql://test:test@localhost:5432/test",
        GOOGLE_CLIENT_ID: "test-client-id",
        GOOGLE_CLIENT_SECRET: "test-client-secret",
        GOOGLE_DEVELOPER_TOKEN: "test-dev-token",
        GOOGLE_MCC_ACCOUNT_ID: "1234567890",
        KEY_SERVICE_URL: "http://localhost:3001",
        KEY_SERVICE_API_KEY: "test-key",
        API_REGISTRY_URL: "http://localhost:4000",
        API_REGISTRY_API_KEY: "test-registry-key",
        RUNS_SERVICE_URL: "http://localhost:3002",
        RUNS_SERVICE_API_KEY: "test-runs-key",
      },
    }));

    const { registerWithServices } = await import("../instrumentation");
    mockFetch.mockResolvedValue({ ok: true });

    await registerWithServices();

    const registryCalls = mockFetch.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("localhost:4000")
    );
    expect(registryCalls).toHaveLength(1);
    expect(registryCalls[0][0]).toBe("http://localhost:4000/services");
  });
});
