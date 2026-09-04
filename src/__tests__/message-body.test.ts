import { describe, it, expect } from "vitest";
import { extractMessageBody } from "../services/message-body";
import type { GmailMessage } from "../services/google-api";

const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64url");

const message = (payload: unknown): GmailMessage =>
  ({ id: "m1", threadId: "t1", payload } as unknown as GmailMessage);

describe("extractMessageBody", () => {
  it("decodes a single-part text/plain body", () => {
    const body = extractMessageBody(
      message({ mimeType: "text/plain", body: { data: b64("Yes, send the deck.") } })
    );
    expect(body.status).toBe("ok");
    expect(body.text).toBe("Yes, send the deck.");
    expect(body.html).toBeNull();
  });

  it("prefers text/plain over text/html in a multipart/alternative message", () => {
    const body = extractMessageBody(
      message({
        mimeType: "multipart/alternative",
        parts: [
          { mimeType: "text/plain", body: { data: b64("plain version") } },
          { mimeType: "text/html", body: { data: b64("<p>html version</p>") } },
        ],
      })
    );
    expect(body.status).toBe("ok");
    expect(body.text).toBe("plain version");
    expect(body.html).toBe("<p>html version</p>");
  });

  it("derives text from html when no text/plain part exists", () => {
    const body = extractMessageBody(
      message({
        mimeType: "multipart/mixed",
        parts: [{ mimeType: "text/html", body: { data: b64("<p>Hi<br/>there</p>") } }],
      })
    );
    expect(body.status).toBe("ok");
    expect(body.text).toBe("Hi\nthere");
    expect(body.html).toContain("<p>Hi");
  });

  it("walks nested parts", () => {
    const body = extractMessageBody(
      message({
        mimeType: "multipart/mixed",
        parts: [
          {
            mimeType: "multipart/alternative",
            parts: [{ mimeType: "text/plain", body: { data: b64("nested text") } }],
          },
          { mimeType: "application/pdf", body: { attachmentId: "att-1" } },
        ],
      })
    );
    expect(body.status).toBe("ok");
    expect(body.text).toBe("nested text");
  });

  it("reports EMPTY when a textual part decodes to nothing", () => {
    const body = extractMessageBody(
      message({ mimeType: "text/plain", body: { data: b64("   ") } })
    );
    expect(body.status).toBe("empty");
    expect(body.text).toBe("   ");
  });

  it("reports UNAVAILABLE when the text lives behind an attachmentId (never fetches it)", () => {
    const body = extractMessageBody(
      message({ mimeType: "text/plain", body: { attachmentId: "att-9", size: 900000 } })
    );
    expect(body.status).toBe("unavailable");
    expect(body.text).toBeNull();
  });

  it("reports UNAVAILABLE when the message carries no textual part at all", () => {
    const body = extractMessageBody(
      message({ mimeType: "multipart/mixed", parts: [{ mimeType: "image/png", body: { attachmentId: "a" } }] })
    );
    expect(body.status).toBe("unavailable");
  });

  it("reports UNAVAILABLE for a missing payload", () => {
    expect(extractMessageBody(null).status).toBe("unavailable");
    expect(extractMessageBody(message(undefined)).status).toBe("unavailable");
  });
});
