import { env } from "../env";
import { trackingHeaders } from "../lib/tracking-headers";

// chat-service `POST /orgs/judgments` (Jev): typed questions about a piece of
// text, answered with the model's own probability distribution. Classification
// only — it never writes text. chat-service resolves the key, provisions,
// authorizes and actualizes the input-token spend against the inbound run, so
// this service declares no LLM cost of its own.

export interface JudgeIdentity {
  orgId: string;
  userId: string;
  runId: string;
  featureSlug?: string;
  brandId?: string;
  audienceId?: string;
}

export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface JudgmentResponse {
  model: string;
  answers: Record<string, ChoiceAnswer>;
  usage: { inputTokens: number; outputTokens: number };
}

const JUDGE_TIMEOUT_MS = 60_000;

export const judgeChoices = async (
  state: string,
  questions: Record<string, ChoiceQuestion>,
  identity: JudgeIdentity
): Promise<JudgmentResponse> => {
  const res = await fetch(`${env.CHAT_SERVICE_URL}/orgs/judgments`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.CHAT_SERVICE_API_KEY,
      "x-org-id": identity.orgId,
      "x-user-id": identity.userId,
      ...trackingHeaders({
        runId: identity.runId,
        featureSlug: identity.featureSlug,
        brandId: identity.brandId,
        audienceId: identity.audienceId,
      }),
    },
    body: JSON.stringify({ state, questions }),
    signal: AbortSignal.timeout(JUDGE_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`chat-service judgments failed: ${res.status} ${body.slice(0, 500)}`);
  }

  const data = (await res.json()) as JudgmentResponse;
  for (const key of Object.keys(questions)) {
    const answer = data.answers?.[key];
    if (!answer || answer.type !== "choice" || typeof answer.choice !== "string") {
      throw new Error(`chat-service judgments: no choice answer for "${key}"`);
    }
  }
  return data;
};
