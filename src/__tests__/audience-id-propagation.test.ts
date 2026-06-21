import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { trackingHeaders } from "../lib/tracking-headers";

vi.mock("../env", () => ({
  env: {
    RUNS_SERVICE_URL: "http://runs.test",
    RUNS_SERVICE_API_KEY: "test-runs-key",
    BILLING_SERVICE_URL: "http://billing.test",
    BILLING_SERVICE_API_KEY: "test-billing-key",
  },
}));

const AUD = "7f9e6c2a-3b4d-4e5f-8a1b-2c3d4e5f6a7b";

const headersOf = (spy: ReturnType<typeof vi.spyOn>): Record<string, string> =>
  (spy.mock.calls[0][1] as RequestInit).headers as Record<string, string>;

// ─── Allowlist builder ───

describe("trackingHeaders builder (allowlist, not cherry-pick)", () => {
  it("emits x-audience-id alongside the other tracking headers when set", () => {
    expect(trackingHeaders({ runId: "r", featureSlug: "f", brandId: "b", audienceId: AUD })).toEqual({
      "x-run-id": "r",
      "x-feature-slug": "f",
      "x-brand-id": "b",
      "x-audience-id": AUD,
    });
  });

  it("omits x-audience-id when unset", () => {
    expect(trackingHeaders({ runId: "r" })).not.toHaveProperty("x-audience-id");
  });

  it("only ever emits the four allowlisted x-* keys", () => {
    const keys = Object.keys(trackingHeaders({ runId: "r", featureSlug: "f", brandId: "b", audienceId: AUD })).sort();
    expect(keys).toEqual(["x-audience-id", "x-brand-id", "x-feature-slug", "x-run-id"]);
  });
});

// ─── Internal egress: runs-service ───

describe("runs-service forwards x-audience-id on internal egress", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "run-x" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      })
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it("createRun sends x-audience-id header when set", async () => {
    const { createRun } = await import("../services/runs-service");
    await createRun({ parentRunId: "parent-run", orgId: "o", userId: "u", service: "google", audienceId: AUD });
    const h = headersOf(fetchSpy);
    expect(h["x-audience-id"]).toBe(AUD);
    expect(h["x-run-id"]).toBe("parent-run");
  });

  it("createRun omits x-audience-id when unset", async () => {
    const { createRun } = await import("../services/runs-service");
    await createRun({ parentRunId: "parent-run", orgId: "o", userId: "u", service: "google" });
    expect(headersOf(fetchSpy)).not.toHaveProperty("x-audience-id");
  });

  it("addCosts sends x-audience-id header so the cost row is tagged", async () => {
    const { addCosts } = await import("../services/runs-service");
    await addCosts(
      "run-1",
      [{ costName: "serper-dev-query", quantity: 1, costSource: "platform" }],
      "o", "u", undefined, undefined, AUD
    );
    expect(headersOf(fetchSpy)["x-audience-id"]).toBe(AUD);
  });
});

// ─── Internal egress: billing-service ───

describe("billing-client forwards x-audience-id on internal egress", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ sufficient: true, balance_cents: 100, required_cents: 1 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it("authorizeCredits sends x-audience-id when set", async () => {
    const { authorizeCredits } = await import("../services/billing-client");
    await authorizeCredits([{ costName: "serper-dev-query", quantity: 1 }], "d", "o", "u", "run-1", undefined, undefined, AUD);
    expect(headersOf(fetchSpy)["x-audience-id"]).toBe(AUD);
  });

  it("authorizeCredits omits x-audience-id when unset", async () => {
    const { authorizeCredits } = await import("../services/billing-client");
    await authorizeCredits([{ costName: "serper-dev-query", quantity: 1 }], "d", "o", "u");
    expect(headersOf(fetchSpy)).not.toHaveProperty("x-audience-id");
  });
});

// ─── External egress strip: serper (vendor) must NEVER receive tracking ───

describe("serper external egress carries no internal tracking headers", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ organic: [], news: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it("searchWeb sends only Content-Type + X-API-KEY (no x-audience-id / x-run-id)", async () => {
    const { searchWeb } = await import("../services/serper");
    await searchWeb({ query: "q" }, "vendor-api-key");
    const h = headersOf(fetchSpy);
    expect(h).not.toHaveProperty("x-audience-id");
    expect(h).not.toHaveProperty("x-run-id");
    expect(h).not.toHaveProperty("x-brand-id");
    expect(Object.keys(h).sort()).toEqual(["Content-Type", "X-API-KEY"]);
  });

  it("searchNews sends only Content-Type + X-API-KEY", async () => {
    const { searchNews } = await import("../services/serper");
    await searchNews({ query: "q" }, "vendor-api-key");
    expect(headersOf(fetchSpy)).not.toHaveProperty("x-audience-id");
  });
});
