import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../db/client", () => {
  const queryMock = vi.fn(async () => ({ rows: [], rowCount: 0 }));
  const endMock = vi.fn(async () => undefined);
  return {
    pool: { query: queryMock, end: endMock },
    query: queryMock,
  };
});

describe("runMigrations", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("executes migration SQL via pool.query", async () => {
    const { pool } = await import("../db/client");
    const { runMigrations } = await import("../db/migrate");

    await runMigrations();

    const queryMock = pool.query as ReturnType<typeof vi.fn>;
    expect(queryMock).toHaveBeenCalledTimes(1);
    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS gmail_messages_raw");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS google_oauth_tokens");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS google_oauth_pending");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS google_contacts_raw");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS accounts");
  });

  it("does not end the pool (boot keeps pool alive for the app)", async () => {
    const { pool } = await import("../db/client");
    const { runMigrations } = await import("../db/migrate");

    await runMigrations();

    const endMock = pool.end as ReturnType<typeof vi.fn>;
    expect(endMock).not.toHaveBeenCalled();
  });

  it("rejects when migration query fails (fail loud)", async () => {
    const { pool } = await import("../db/client");
    const queryMock = pool.query as ReturnType<typeof vi.fn>;
    queryMock.mockRejectedValueOnce(new Error("syntax error"));

    const { runMigrations } = await import("../db/migrate");
    await expect(runMigrations()).rejects.toThrow("syntax error");
  });
});
