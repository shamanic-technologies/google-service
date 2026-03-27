import { env } from "../env";

export interface AuthorizeCreditItem {
  costName: string;
  quantity: number;
}

export interface AuthorizeCreditsResult {
  sufficient: boolean;
  balance_cents: number;
  required_cents: number;
}

export const authorizeCredits = async (
  items: AuthorizeCreditItem[],
  description: string,
  orgId: string,
  userId: string,
  runId?: string,
  featureSlug?: string
): Promise<AuthorizeCreditsResult> => {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-API-Key": env.BILLING_SERVICE_API_KEY,
    "x-org-id": orgId,
    "x-user-id": userId,
  };

  if (runId) headers["x-run-id"] = runId;
  if (featureSlug) headers["x-feature-slug"] = featureSlug;

  const res = await fetch(`${env.BILLING_SERVICE_URL}/v1/credits/authorize`, {
    method: "POST",
    headers,
    body: JSON.stringify({ items, description }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`[google-service] Billing authorize failed: ${res.status} body=${body}`);
    throw new Error(`Billing authorize failed: ${res.status} ${body}`);
  }

  return res.json() as Promise<AuthorizeCreditsResult>;
};
