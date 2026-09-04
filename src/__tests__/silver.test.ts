import { describe, it, expect, vi } from "vitest";

vi.mock("../db/client", () => ({
  pool: { query: vi.fn() },
  query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
}));

import { parseContactSilver, parseMessageSilver } from "../services/silver";
import type { GmailMessage, PersonResource } from "../services/google-api";

describe("parseContactSilver", () => {
  it("extracts typed fields from a full People payload", () => {
    const person: PersonResource = {
      resourceName: "people/c1",
      etag: "e1",
      names: [{ displayName: "Ada Lovelace" }],
      emailAddresses: [
        { value: "secondary@x.com" },
        { value: "ada@x.com", metadata: { primary: true } },
      ],
      phoneNumbers: [{ value: "+15551234567" }, { value: "" }],
      organizations: [{ name: "Analytical Engines", title: "Mathematician" }],
      photos: [{ url: "https://p/a.jpg", metadata: { primary: true } }],
      metadata: {
        deleted: false,
        sources: [
          { updateTime: "2026-01-01T00:00:00Z" },
          { updateTime: "2026-05-01T00:00:00Z" },
        ],
      },
    } as unknown as PersonResource;

    const s = parseContactSilver(person);
    expect(s.displayName).toBe("Ada Lovelace");
    expect(s.primaryEmail).toBe("ada@x.com"); // picks metadata.primary, not first
    expect(s.emails).toEqual(["secondary@x.com", "ada@x.com"]);
    expect(s.phones).toEqual(["+15551234567"]); // empty string filtered
    expect(s.organization).toBe("Analytical Engines");
    expect(s.jobTitle).toBe("Mathematician");
    expect(s.photoUrl).toBe("https://p/a.jpg");
    expect(s.updatedAt).toBe("2026-05-01T00:00:00Z"); // latest updateTime
    expect(s.deleted).toBe(false);
  });

  it("falls back to first email when none flagged primary", () => {
    const s = parseContactSilver({
      resourceName: "otherContacts/c9",
      emailAddresses: [{ value: "only@x.com" }],
    } as unknown as PersonResource);
    expect(s.primaryEmail).toBe("only@x.com");
  });

  it("handles a minimal/empty payload with nulls and empty arrays", () => {
    const s = parseContactSilver({ resourceName: "people/c0" } as PersonResource);
    expect(s).toEqual({
      displayName: null,
      primaryEmail: null,
      emails: [],
      phones: [],
      organization: null,
      jobTitle: null,
      photoUrl: null,
      updatedAt: null,
      deleted: false,
    });
  });

  it("reports deleted=true from metadata", () => {
    const s = parseContactSilver({
      resourceName: "people/c2",
      metadata: { deleted: true },
    } as unknown as PersonResource);
    expect(s.deleted).toBe(true);
  });
});

describe("parseMessageSilver", () => {
  const baseMessage = (overrides: Partial<GmailMessage> = {}): GmailMessage =>
    ({
      id: "m1",
      threadId: "t1",
      historyId: "12345",
      internalDate: "1748000000000",
      labelIds: ["INBOX", "IMPORTANT"],
      snippet: "hello there",
      payload: {
        headers: [
          { name: "From", value: '"Grace Hopper" <grace@navy.mil>' },
          { name: "To", value: "a@x.com, Bob <bob@y.com>" },
          { name: "Subject", value: "Compilers" },
          { name: "Date", value: "Wed, 23 May 2026 10:00:00 +0000" },
        ],
      },
      ...overrides,
    }) as unknown as GmailMessage;

  it("parses Cc participants (indexed match for a Cc-only correspondent)", () => {
    const s = parseMessageSilver(
      baseMessage({
        payload: {
          headers: [
            { name: "From", value: "grace@navy.mil" },
            { name: "To", value: "a@x.com" },
            { name: "Cc", value: "Watcher <watch@z.com>, third@z.com" },
          ],
        },
      } as Partial<GmailMessage>)
    );
    expect(s.cc).toEqual(["watch@z.com", "third@z.com"]);
  });

  it("parses From/To/Subject headers and metadata", () => {
    const s = parseMessageSilver(baseMessage());
    expect(s.fromName).toBe("Grace Hopper");
    expect(s.fromEmail).toBe("grace@navy.mil");
    expect(s.to).toEqual(["a@x.com", "bob@y.com"]);
    expect(s.subject).toBe("Compilers");
    expect(s.snippet).toBe("hello there");
    expect(s.labels).toEqual(["INBOX", "IMPORTANT"]);
    expect(s.historyId).toBe("12345");
    expect(s.sentAt).toBe(new Date(1748000000000).toISOString());
  });

  it("falls back to the Date header when internalDate is absent", () => {
    const s = parseMessageSilver(baseMessage({ internalDate: undefined }));
    expect(s.sentAt).toBe(new Date("Wed, 23 May 2026 10:00:00 +0000").toISOString());
  });

  it("parses a bare-email From with no display name", () => {
    const s = parseMessageSilver(
      baseMessage({
        payload: { headers: [{ name: "From", value: "solo@x.com" }] },
      } as unknown as Partial<GmailMessage>)
    );
    expect(s.fromEmail).toBe("solo@x.com");
    expect(s.fromName).toBeNull();
  });

  it("handles a payload with no headers", () => {
    const s = parseMessageSilver({
      id: "m2",
      threadId: "t2",
      historyId: "1",
      payload: {},
    } as unknown as GmailMessage);
    expect(s.fromEmail).toBeNull();
    expect(s.to).toEqual([]);
    expect(s.subject).toBeNull();
    expect(s.labels).toEqual([]);
  });
});
