// GOOGLE-TOKENS-AT-REST-1127: a boot without GOOGLE_SERVICE_ENCRYPTION_KEY dies
// before touching the database or binding the port (the deploy health check
// then rolls back), never a service that answers and 500s on every sync.
import { describe, it, expect, vi } from "vitest";

const mocks = vi.hoisted(() => ({ runMigrations: vi.fn(), createApp: vi.fn(), encryptStoredTokens: vi.fn() }));
vi.mock("../env", () => ({ env: { PORT: 0 } }));
vi.mock("../db/migrate", () => ({ runMigrations: mocks.runMigrations }));
vi.mock("../app", () => ({ createApp: mocks.createApp }));
vi.mock("../services/encrypt-tokens-at-rest", () => ({ encryptStoredTokens: mocks.encryptStoredTokens }));
vi.mock("../services/backfill-silver", () => ({ backfillSilver: vi.fn() }));
vi.mock("../services/cron-sync", () => ({
  startAutoSync: vi.fn(),
  startCalendarSync: vi.fn(),
  startGmailFreshSync: vi.fn(),
  startSearchConsoleSync: vi.fn(),
}));
vi.mock("../services/spend-cron", () => ({ startSpendSync: vi.fn() }));
vi.mock("../services/thread-reply-outcomes", () => ({ startThreadReplyOutcomes: vi.fn() }));
vi.mock("../services/account-purge", () => ({ resumePendingPurges: vi.fn() }));
vi.mock("../services/search-index", () => ({ ensurePhraseSearchIndex: vi.fn() }));

describe("boot without the token encryption key", () => {
  it("exits 1 before migrations, the at-rest pass or listen", async () => {
    delete process.env.GOOGLE_SERVICE_ENCRYPTION_KEY;
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await import("../index");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(String(err.mock.calls[0]?.[1])).toMatch(/GOOGLE_SERVICE_ENCRYPTION_KEY is required/);
    expect(mocks.runMigrations).not.toHaveBeenCalled();
    expect(mocks.encryptStoredTokens).not.toHaveBeenCalled();
    expect(mocks.createApp).not.toHaveBeenCalled();
  });
});
