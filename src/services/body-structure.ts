// Deterministic half of the conversation body cleaner: only what the mail
// itself MARKS, never a guess about what a block of words is.
//
// What is removed here, and why each is structure rather than judgment:
// - Quoted history: the standard reply separators ("On … wrote:", "Le … a écrit :",
//   "-----Original Message-----", a forwarded-message banner, an Outlook
//   "From:/Sent:" header block) and `>`-quoted lines. Everything from the first
//   separator down is the previous message, by the mail client's own marking.
// - Signature: the conventional "-- " delimiter line (RFC 3676), and everything
//   below it.
// - Long URLs: a bare URL over LONG_URL_CHARS is a tracking link nobody reads;
//   a short one (a profile, a booking page) stays.
// - Wordless lines: a line with no letter or digit left ("}", ".....", "-----")
//   carries no words of the sender.
//
// Whether a remaining line is the sender's words, a footer, a signature written
// without the delimiter or a legal block is a JUDGMENT, made by Jev in
// body-clean.ts — never by growing this file.

export const LONG_URL_CHARS = 100;

export interface StructuredLine {
  text: string;
  // A blank line preceded this one in the source: the paragraph break is kept
  // when the cleaned text is reassembled.
  breakBefore: boolean;
}

// A reply header can wrap over up to three lines in plain-text clients:
// "On Mon, October 5, 2026 3:18 PM, Summer Williams <s@x.com>\n[s@x.com]> wrote:".
const REPLY_HEADER_WINDOW = 3;
const REPLY_HEADER = /^\s*(On\s.+\swrote:|Le\s.+\sa\s+écrit\s*:|El\s.+\sescribió:|Am\s.+\sschrieb\s.+:)\s*$/is;
const SEPARATOR_LINES = [
  /^\s*-{2,}\s*Original Message\s*-{2,}\s*$/i,
  /^\s*-{2,}\s*Forwarded message\s*-{2,}\s*$/i,
  /^\s*-{2,}\s*Message d'origine\s*-{2,}\s*$/i,
  /^\s*Begin forwarded message:\s*$/i,
];
const OUTLOOK_FROM = /^\s*\*?(From|De)\s*:\*?\s+\S/i;
const OUTLOOK_NEXT = /^\s*\*?(Sent|Date|Envoyé|To|À)\s*:\*?\s/i;
const SIGNATURE_DELIMITER = /^\s*--\s*$/;
const URL = /https?:\/\/[^\s<>()[\]"']+/gi;
const EMPTY_WRAPPERS = /(\(\s*\)|<\s*>|\[\s*\])/g;
const HAS_WORD = /[\p{L}\p{N}]/u;

const findHistoryStart = (lines: string[]): number => {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (SEPARATOR_LINES.some((re) => re.test(line))) return i;
    if (/^\s*_{10,}\s*$/.test(line) && OUTLOOK_FROM.test(lines[i + 1] ?? "")) return i;
    if (OUTLOOK_FROM.test(line) && lines.slice(i + 1, i + 4).some((l) => OUTLOOK_NEXT.test(l))) return i;
    if (/^\s*(On|Le|El|Am)\s/.test(line)) {
      for (let span = 1; span <= REPLY_HEADER_WINDOW; span++) {
        const window = lines.slice(i, i + span).join(" ");
        if (REPLY_HEADER.test(window)) return i;
      }
    }
  }
  return -1;
};

const stripLongUrls = (line: string): string =>
  line.replace(URL, (url) => (url.length > LONG_URL_CHARS ? "" : url)).replace(EMPTY_WRAPPERS, "");

/** Split a plain-text body into the lines that may be the sender's words. */
export const structureBody = (text: string): StructuredLine[] => {
  const all = text.replace(/\r\n?/g, "\n").split("\n");

  let lines = all;
  const historyStart = findHistoryStart(lines);
  if (historyStart >= 0) lines = lines.slice(0, historyStart);
  const signatureStart = lines.findIndex((l) => SIGNATURE_DELIMITER.test(l));
  if (signatureStart >= 0) lines = lines.slice(0, signatureStart);

  const out: StructuredLine[] = [];
  let pendingBreak = false;
  for (const raw of lines) {
    if (/^\s*>/.test(raw)) continue;
    const cleaned = stripLongUrls(raw).replace(/\s+$/, "").replace(/^\s+/, "");
    if (!HAS_WORD.test(cleaned)) {
      // Blank lines and wordless rules ("-----", ".....") both separate sections.
      pendingBreak = true;
      continue;
    }
    out.push({ text: cleaned, breakBefore: out.length > 0 && pendingBreak });
    pendingBreak = false;
  }
  return out;
};

/** Reassemble kept lines, one paragraph break where the source had one. */
export const joinLines = (lines: StructuredLine[]): string =>
  lines
    .map((l, i) => (i > 0 && l.breakBefore ? `\n${l.text}` : l.text))
    .join("\n");
