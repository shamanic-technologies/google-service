import { env } from "../env";
import { trackingHeaders } from "../lib/tracking-headers";

const baseHeaders = () => ({
  "Content-Type": "application/json",
  "x-api-key": env.RUNS_SERVICE_API_KEY,
});

export interface CreateRunParams {
  parentRunId: string;
  orgId: string;
  userId: string;
  service: string;
  featureSlug?: string;
  brandId?: string;
  audienceId?: string;
}

export interface CostItem {
  costName: string;
  quantity: number;
  costSource: "platform" | "org";
}

export const createRun = async (params: CreateRunParams): Promise<string> => {
  const res = await fetch(`${env.RUNS_SERVICE_URL}/v1/runs`, {
    method: "POST",
    headers: {
      ...baseHeaders(),
      "x-org-id": params.orgId,
      "x-user-id": params.userId,
      ...trackingHeaders({
        runId: params.parentRunId,
        featureSlug: params.featureSlug,
        brandId: params.brandId,
        audienceId: params.audienceId,
      }),
    },
    body: JSON.stringify({
      serviceName: params.service,
      taskName: "request",
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`[google-service] Failed to create run: ${res.status} body=${body}`);
    throw new Error(`Failed to create run: ${res.status} ${body}`);
  }

  const data = (await res.json()) as { id: string };
  return data.id;
};

export const updateRun = async (
  runId: string,
  status: "completed" | "failed",
  orgId: string,
  userId: string,
  featureSlug?: string,
  brandId?: string,
  audienceId?: string
): Promise<void> => {
  const res = await fetch(`${env.RUNS_SERVICE_URL}/v1/runs/${runId}`, {
    method: "PATCH",
    headers: {
      ...baseHeaders(),
      "x-org-id": orgId,
      "x-user-id": userId,
      ...trackingHeaders({ runId, featureSlug, brandId, audienceId }),
    },
    body: JSON.stringify({ status }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`[google-service] Failed to update run ${runId}: ${res.status} body=${body}`);
    throw new Error(`Failed to update run: ${res.status} ${body}`);
  }
};

export const addCosts = async (
  runId: string,
  items: CostItem[],
  orgId: string,
  userId: string,
  featureSlug?: string,
  brandId?: string,
  audienceId?: string
): Promise<void> => {
  const res = await fetch(`${env.RUNS_SERVICE_URL}/v1/runs/${runId}/costs`, {
    method: "POST",
    headers: {
      ...baseHeaders(),
      "x-org-id": orgId,
      "x-user-id": userId,
      ...trackingHeaders({ runId, featureSlug, brandId, audienceId }),
    },
    body: JSON.stringify({ items }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`[google-service] Failed to add costs to run ${runId}: ${res.status} body=${body}`);
    throw new Error(`Failed to add costs: ${res.status} ${body}`);
  }
};
