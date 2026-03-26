import { env } from "../env";

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
}

export const createRun = async (params: CreateRunParams): Promise<string> => {
  const res = await fetch(`${env.RUNS_SERVICE_URL}/v1/runs`, {
    method: "POST",
    headers: {
      ...baseHeaders(),
      "x-org-id": params.orgId,
      "x-user-id": params.userId,
      ...(params.parentRunId ? { "x-run-id": params.parentRunId } : {}),
      ...(params.featureSlug ? { "x-feature-slug": params.featureSlug } : {}),
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
