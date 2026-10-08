import { query } from "../db/client";
import { structureBody, joinLines, type StructuredLine } from "./body-structure";
import { judgeChoices, type ChoiceQuestion, type JudgeIdentity } from "./chat-service";

// What the sender actually wrote, per message, for the conversation read.
//
// Two halves:
// 1. body-structure.ts removes what the mail itself MARKS (reply separators,
//    `>` quotes, the "-- " signature delimiter, long tracking URLs, wordless
//    lines). Pure, computed on read.
// 2. Everything left is JUDGED by Jev (chat-service judgments): one call per
//    message, one choice question per line — is this the sender's words, a
//    signature, a footer, a bare link label, a template artifact? The words are
//    never rewritten: a line is kept or dropped, verbatim.
//
// The judgment is persisted per message (`gmail_message_clean_bodies`) and
// keyed on CLEANER_VERSION, so each message is judged ONCE and never per read;
// bumping the version (new questions, new structure rules) re-judges lazily.
//
// The original body is never touched: the read serves it beside the cleaned
// text. A message whose every line is judged non-message is NOT dropped and NOT
// silently shown raw: it is served with its original text and flagged
// `nothing_kept`.

export const CLEANER_VERSION = 1;

// A line the model is not reasonably sure is NOT the sender's words is kept:
// hiding a sentence someone wrote is worse than showing one footer line.
export const KEEP_IF_MESSAGE_PROBABILITY_AT_LEAST = 0.3;

// Bounds on one judgment call.
export const MAX_UNITS = 60;
const UNIT_CHARS_IN_STATE = 300;

// Bounds on one READ: the rest stays `pending` and is judged by the next read,
// so a first open of a very long exchange costs bounded latency and spend.
export const MAX_JUDGED_PER_READ = 30;
const JUDGE_CONCURRENCY = 6;

export type BodyCleanStatus =
  // Judged: `text` is the sender's own lines (it may equal the original).
  | "cleaned"
  // Judged (or structurally empty): nothing left is the sender's words. The
  // ORIGINAL is served, flagged, never an empty message.
  | "nothing_kept"
  // Not judged yet (over this read's budget): structure-only clean served,
  // judged on a later read.
  | "pending"
  // The judgment call failed: structure-only clean served, retried next read.
  | "judge_failed"
  // No readable body to clean (bodyStatus is empty/unavailable).
  | "not_applicable"
  // This read does not clean bodies (the staff exchange read).
  | "not_cleaned";

export interface CleanedBody {
  text: string | null;
  status: BodyCleanStatus;
}

export const LINE_KINDS = {
  message:
    "The sender's own words to the reader, including a greeting or sign-off. For an automated notification: what it is telling the reader, including who messaged them (name and headline) and how many messages",
  signature:
    "The contact block AFTER the sender's message: their name, job title, company, phone, postal address, social links",
  footer:
    "Footer of a mass or automated email: who it was intended for, why you are receiving it, unsubscribe, preferences, help, privacy, copyright, legal or company address",
  link_label: "A button or link label with no message of its own (View message, Reply, View in browser, Yes/No buttons)",
  artifact: "A tracking code, template leftover or markup that means nothing to a reader",
  quoted: "Text quoted from an earlier message in the thread",
} as const;

type LineKind = keyof typeof LINE_KINDS;

interface Unit {
  lines: StructuredLine[];
  text: string;
}

/** Lines, or paragraphs, or merged paragraphs: whatever fits in MAX_UNITS questions. */
export const toUnits = (lines: StructuredLine[]): Unit[] => {
  const unitOf = (group: StructuredLine[]): Unit => ({
    lines: group,
    text: group.map((l) => l.text).join(" "),
  });
  if (lines.length <= MAX_UNITS) return lines.map((l) => unitOf([l]));

  const paragraphs: StructuredLine[][] = [];
  for (const line of lines) {
    if (paragraphs.length === 0 || line.breakBefore) paragraphs.push([line]);
    else paragraphs[paragraphs.length - 1].push(line);
  }
  if (paragraphs.length <= MAX_UNITS) return paragraphs.map(unitOf);

  const perUnit = Math.ceil(paragraphs.length / MAX_UNITS);
  const units: Unit[] = [];
  for (let i = 0; i < paragraphs.length; i += perUnit) {
    units.push(unitOf(paragraphs.slice(i, i + perUnit).flat()));
  }
  return units;
};

const clip = (s: string): string => (s.length > UNIT_CHARS_IN_STATE ? `${s.slice(0, UNIT_CHARS_IN_STATE)}…` : s);

export const buildJudgment = (
  subject: string | null,
  units: Unit[]
): { state: string; questions: Record<string, ChoiceQuestion> } => {
  const state = [
    `Email subject: ${subject ?? "(none)"}`,
    "Email body, one numbered line per entry:",
    ...units.map((u, i) => `[${i + 1}] ${clip(u.text)}`),
  ].join("\n");

  const questions: Record<string, ChoiceQuestion> = {};
  units.forEach((u, i) => {
    questions[`u${i + 1}`] = {
      type: "choice",
      instructions: `What is line [${i + 1}] of this email ("${clip(u.text)}")?`,
      criteria: { ...LINE_KINDS },
    };
  });
  return { state, questions };
};

interface UnitVerdict {
  text: string;
  kind: string;
  messageProbability: number;
  kept: boolean;
}

interface JudgedRow {
  status: "cleaned" | "nothing_kept";
  cleanText: string | null;
}

const judgeMessage = async (
  orgId: string,
  gmailMessageId: string,
  subject: string | null,
  units: Unit[],
  identity: JudgeIdentity
): Promise<JudgedRow> => {
  const { state, questions } = buildJudgment(subject, units);
  const judgment = await judgeChoices(state, questions, identity);

  const verdicts: UnitVerdict[] = units.map((u, i) => {
    const answer = judgment.answers[`u${i + 1}`];
    const messageProbability = answer.probabilities?.message;
    if (typeof messageProbability !== "number") {
      throw new Error(`chat-service judgments: no "message" probability for u${i + 1}`);
    }
    return {
      text: u.text,
      kind: answer.choice as LineKind,
      messageProbability,
      kept: answer.choice === "message" || messageProbability >= KEEP_IF_MESSAGE_PROBABILITY_AT_LEAST,
    };
  });

  const keptLines = units.flatMap((u, i) => (verdicts[i].kept ? u.lines : []));
  const row: JudgedRow =
    keptLines.length > 0
      ? { status: "cleaned", cleanText: joinLines(keptLines) }
      : { status: "nothing_kept", cleanText: null };

  await query(
    `INSERT INTO gmail_message_clean_bodies
       (org_id, gmail_message_id, cleaner_version, status, clean_text, verdicts, model, input_tokens, judged_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, NOW())
     ON CONFLICT (org_id, gmail_message_id) DO UPDATE SET
       cleaner_version = EXCLUDED.cleaner_version,
       status = EXCLUDED.status,
       clean_text = EXCLUDED.clean_text,
       verdicts = EXCLUDED.verdicts,
       model = EXCLUDED.model,
       input_tokens = EXCLUDED.input_tokens,
       judged_at = EXCLUDED.judged_at`,
    [
      orgId,
      gmailMessageId,
      CLEANER_VERSION,
      row.status,
      row.cleanText,
      JSON.stringify(verdicts),
      judgment.model,
      judgment.usage.inputTokens,
    ]
  );
  return row;
};

export interface CleanInput {
  gmailMessageId: string;
  subject: string | null;
  // The readable body as served before cleaning, and whether it was readable.
  text: string | null;
  readable: boolean;
}

const runPool = async <T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> => {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
};

/**
 * Cleaned body per message. `messages` is ordered oldest-first, as the
 * conversation serves it; when over budget the NEWEST messages are judged first.
 */
export const cleanBodies = async (
  orgId: string,
  messages: CleanInput[],
  identity: JudgeIdentity
): Promise<Map<string, CleanedBody>> => {
  const out = new Map<string, CleanedBody>();
  const toJudge: { input: CleanInput; units: Unit[]; structural: string }[] = [];

  const readable = messages.filter((m) => m.readable && m.text !== null && m.text.trim().length > 0);
  for (const m of messages) {
    if (!readable.includes(m)) out.set(m.gmailMessageId, { text: m.text, status: "not_applicable" });
  }
  if (readable.length === 0) return out;

  const stored = await query(
    `SELECT gmail_message_id, status, clean_text
       FROM gmail_message_clean_bodies
       WHERE org_id = $1 AND gmail_message_id = ANY($2::text[]) AND cleaner_version = $3`,
    [orgId, readable.map((m) => m.gmailMessageId), CLEANER_VERSION]
  );
  const byId = new Map(stored.rows.map((r) => [r.gmail_message_id as string, r]));

  for (const m of readable) {
    const text = m.text as string;
    const row = byId.get(m.gmailMessageId);
    if (row) {
      out.set(
        m.gmailMessageId,
        row.status === "cleaned"
          ? { text: row.clean_text as string, status: "cleaned" }
          : { text, status: "nothing_kept" }
      );
      continue;
    }
    const lines = structureBody(text);
    if (lines.length === 0) {
      // Structure alone left nothing (e.g. a forward with no comment): nothing to
      // judge, and the original is served flagged rather than an empty message.
      out.set(m.gmailMessageId, { text, status: "nothing_kept" });
      continue;
    }
    toJudge.push({ input: m, units: toUnits(lines), structural: joinLines(lines) });
  }

  const newestFirst = [...toJudge].reverse();
  const now = newestFirst.slice(0, MAX_JUDGED_PER_READ);
  for (const later of newestFirst.slice(MAX_JUDGED_PER_READ)) {
    out.set(later.input.gmailMessageId, { text: later.structural, status: "pending" });
  }

  await runPool(now, JUDGE_CONCURRENCY, async ({ input, units, structural }) => {
    try {
      const row = await judgeMessage(orgId, input.gmailMessageId, input.subject, units, identity);
      out.set(
        input.gmailMessageId,
        row.status === "cleaned"
          ? { text: row.cleanText, status: "cleaned" }
          : { text: input.text, status: "nothing_kept" }
      );
    } catch (err) {
      // Flagged on the message (never presented as cleaned) and retried by the
      // next read; logged so a persistent failure is seen.
      console.error(`[google-service] Body judgment failed for message ${input.gmailMessageId}:`, err);
      out.set(input.gmailMessageId, { text: structural, status: "judge_failed" });
    }
  });

  return out;
};
