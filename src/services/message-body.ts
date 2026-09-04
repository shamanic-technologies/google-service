import type { GmailMessage } from "./google-api";

// Readable body derived ON READ from the bronze Gmail payload.
//
// Why on read and not at ingest: the mirror already stores the provider's full
// `messages.get format=full` payload, so the readable text is a pure function of
// a row we already hold. Deriving it on read means every historical message is
// readable immediately — no backfill of a ~700k-row table, no boot-window work,
// and no schema change — which matters while the outreach provider's copy is
// about to be deleted. Conversation reads are bounded (one person's exchange),
// so the parse cost is paid on a handful of rows per request.
//
// Never calls Google: a part whose text lives behind an `attachmentId` (Gmail
// externalises large bodies) is reported UNAVAILABLE rather than fetched.

export type BodyStatus = "ok" | "empty" | "unavailable";

export interface MessageBody {
  text: string | null;
  html: string | null;
  // "ok"          — readable text/html was decoded from the payload
  // "empty"       — a body part exists and decodes to nothing (the message
  //                 genuinely says nothing)
  // "unavailable" — we hold the message but cannot read it here (body behind an
  //                 attachmentId, or no textual part at all). NEVER conflate
  //                 this with "empty": one means we could not read it, the
  //                 other means there was nothing to read.
  status: BodyStatus;
}

type AnyRecord = Record<string, unknown>;

const asArray = (v: unknown): AnyRecord[] => (Array.isArray(v) ? (v as AnyRecord[]) : []);

const decodeBase64Url = (data: string): string | null => {
  try {
    return Buffer.from(data, "base64url").toString("utf-8");
  } catch {
    return null;
  }
};

interface Collected {
  text: string[];
  html: string[];
  // A textual part existed but its content is not in the payload (attachmentId)
  // or failed to decode.
  sawUnreadablePart: boolean;
  sawTextualPart: boolean;
}

const walk = (part: AnyRecord | undefined, acc: Collected): void => {
  if (!part) return;

  const mimeType = typeof part.mimeType === "string" ? part.mimeType.toLowerCase() : "";
  const body = (part.body as AnyRecord | undefined) ?? {};
  const data = typeof body.data === "string" ? body.data : null;
  const hasAttachmentId = typeof body.attachmentId === "string" && body.attachmentId.length > 0;

  const isText = mimeType.startsWith("text/plain");
  const isHtml = mimeType.startsWith("text/html");
  // A part with body data and no declared mimeType (single-part messages often
  // omit it) is treated as text rather than dropped.
  const isBare = mimeType === "" && data !== null;

  if (isText || isHtml || isBare) {
    acc.sawTextualPart = true;
    if (data !== null) {
      const decoded = decodeBase64Url(data);
      if (decoded === null) {
        acc.sawUnreadablePart = true;
      } else if (isHtml) {
        acc.html.push(decoded);
      } else {
        acc.text.push(decoded);
      }
    } else if (hasAttachmentId) {
      // Gmail externalised the content; reading it would require a Google call.
      acc.sawUnreadablePart = true;
    }
  }

  for (const child of asArray(part.parts)) walk(child, acc);
};

// Very small HTML → text reduction, used only when a message carries no
// text/plain alternative. Not a sanitiser: the raw html is returned alongside.
const htmlToText = (html: string): string =>
  html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

export const extractMessageBody = (message: GmailMessage | null | undefined): MessageBody => {
  if (!message) return { text: null, html: null, status: "unavailable" };

  const acc: Collected = { text: [], html: [], sawUnreadablePart: false, sawTextualPart: false };
  walk((message.payload as AnyRecord | undefined) ?? undefined, acc);

  const html = acc.html.length > 0 ? acc.html.join("\n") : null;
  const plain = acc.text.length > 0 ? acc.text.join("\n") : null;
  const text = plain ?? (html !== null ? htmlToText(html) : null);

  const hasContent =
    (text !== null && text.trim().length > 0) || (html !== null && html.trim().length > 0);

  if (hasContent) return { text, html, status: "ok" };
  // A textual part that decoded to nothing is an empty message; anything else
  // (no textual part, or content we could not read) is unavailable.
  if (acc.sawTextualPart && !acc.sawUnreadablePart) {
    return { text: text ?? "", html, status: "empty" };
  }
  return { text: null, html: null, status: "unavailable" };
};
