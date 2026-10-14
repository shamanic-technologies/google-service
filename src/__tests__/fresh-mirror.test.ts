import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockIngestGmail, mockListOrgAccounts } = vi.hoisted(() => ({
  mockIngestGmail: vi.fn(),
  mockListOrgAccounts: vi.fn(),
}));

vi.mock("../services/gmail-ingest", () => ({
  ingestGmailForAccount: (...args: unknown[]) => mockIngestGmail(...args),
}));

vi.mock("../services/google-tokens", () => ({
  listOrgGoogleAccounts: (...args: unknown[]) => mockListOrgAccounts(...args),
}));

import {
  ensureFreshGmailMirror,
  FRESH_MAX_AGE_MS,
  FreshMirrorError,
  resetFreshMirrorState,
} from "../services/fresh-mirror";

const CALLER = { method: "GET", path: "/conversation" };

const account = (over: Record<string, unknown> = {}) => ({
  id: "acc-1",
  orgId: "org-a",
  userId: "u",
  googleAccountEmail: "owner@brand.com",
  refreshToken: "rt",
  accessToken: null,
  accessTokenExpiresAt: null,
  scopes: "",
  gmailHistoryId: "100",
  peopleSyncToken: null,
  otherContactsSyncToken: null,
  gmailUnavailableAt: null,
  ...over,
});

const deferred = () => {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

beforeEach(() => {
  vi.clearAllMocks();
  resetFreshMirrorState();
  mockListOrgAccounts.mockResolvedValue([account()]);
  mockIngestGmail.mockResolvedValue({ inserted: 0, updated: 0, unchanged: 0 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ensureFreshGmailMirror", () => {
  it("runs one delta per caught-up mailbox of the org, skipping mailboxes without Gmail", async () => {
    mockListOrgAccounts.mockResolvedValue([
      account(),
      account({ id: "acc-2", googleAccountEmail: "b@brand.com" }),
      account({ id: "acc-3", gmailUnavailableAt: new Date() }),
    ]);
    await ensureFreshGmailMirror("org-a", CALLER, "run-1");
    expect(mockListOrgAccounts).toHaveBeenCalledWith("org-a");
    expect(mockIngestGmail.mock.calls.map((c) => (c[0] as { id: string }).id)).toEqual(["acc-1", "acc-2"]);
  });

  it("coalesces concurrent fresh reads of one org into one refresh", async () => {
    const d = deferred();
    mockIngestGmail.mockImplementation(() => d.promise.then(() => ({ inserted: 0, updated: 0, unchanged: 0 })));
    const reads = [1, 2, 3].map(() => ensureFreshGmailMirror("org-a", CALLER, "run"));
    await Promise.resolve();
    d.resolve();
    await Promise.all(reads);
    expect(mockIngestGmail).toHaveBeenCalledTimes(1);
  });

  it("a refresh that just completed satisfies a read within the freshness window", async () => {
    vi.useFakeTimers();
    await ensureFreshGmailMirror("org-a", CALLER, "run");
    vi.advanceTimersByTime(FRESH_MAX_AGE_MS - 1);
    await ensureFreshGmailMirror("org-a", CALLER, "run");
    expect(mockIngestGmail).toHaveBeenCalledTimes(1);
  });

  it("refreshes again once the last refresh is older than the window", async () => {
    vi.useFakeTimers();
    await ensureFreshGmailMirror("org-a", CALLER, "run");
    vi.advanceTimersByTime(FRESH_MAX_AGE_MS + 1);
    await ensureFreshGmailMirror("org-a", CALLER, "run");
    expect(mockIngestGmail).toHaveBeenCalledTimes(2);
  });

  it("never reuses an in-flight refresh that started before the window: waits, then runs its own", async () => {
    vi.useFakeTimers();
    const first = deferred();
    mockIngestGmail
      .mockImplementationOnce(() => first.promise.then(() => ({ inserted: 0, updated: 0, unchanged: 0 })))
      .mockResolvedValue({ inserted: 0, updated: 0, unchanged: 0 });
    const early = ensureFreshGmailMirror("org-a", CALLER, "run");
    await vi.advanceTimersByTimeAsync(FRESH_MAX_AGE_MS + 1);
    const late = ensureFreshGmailMirror("org-a", CALLER, "run");
    await Promise.resolve();
    expect(mockIngestGmail).toHaveBeenCalledTimes(1);
    first.resolve();
    await Promise.all([early, late]);
    expect(mockIngestGmail).toHaveBeenCalledTimes(2);
  });

  it("does not share refreshes across orgs", async () => {
    await ensureFreshGmailMirror("org-a", CALLER, "run");
    await ensureFreshGmailMirror("org-b", CALLER, "run");
    expect(mockListOrgAccounts.mock.calls.map((c) => c[0])).toEqual(["org-a", "org-b"]);
  });

  it("fails every coalesced read when the refresh fails, and the next read retries", async () => {
    mockIngestGmail.mockRejectedValueOnce(new Error("Gmail 500"));
    const reads = [ensureFreshGmailMirror("org-a", CALLER, "run"), ensureFreshGmailMirror("org-a", CALLER, "run")];
    for (const r of reads) {
      await expect(r).rejects.toBeInstanceOf(FreshMirrorError);
    }
    await expect(ensureFreshGmailMirror("org-a", CALLER, "run")).resolves.toBeUndefined();
    expect(mockIngestGmail).toHaveBeenCalledTimes(2);
  });

  it("fails when the account list cannot be read", async () => {
    mockListOrgAccounts.mockRejectedValueOnce(new Error("db down"));
    await expect(ensureFreshGmailMirror("org-a", CALLER, "run")).rejects.toMatchObject({
      reason: "gmail_refresh_failed",
    });
  });

  it("fails with gmail_mirror_not_caught_up for a mailbox whose first sync has not finished", async () => {
    mockListOrgAccounts.mockResolvedValue([account({ gmailHistoryId: null })]);
    await expect(ensureFreshGmailMirror("org-a", CALLER, "run")).rejects.toMatchObject({
      reason: "gmail_mirror_not_caught_up",
    });
    expect(mockIngestGmail).not.toHaveBeenCalled();
  });

  it("an org with no mailbox is trivially fresh", async () => {
    mockListOrgAccounts.mockResolvedValue([]);
    await expect(ensureFreshGmailMirror("org-a", CALLER, "run")).resolves.toBeUndefined();
  });
});
