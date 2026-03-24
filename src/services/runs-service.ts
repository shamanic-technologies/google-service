import { env } from "../env";

const headers = () => ({
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
      ...headers(),
      ...(params.featureSlug ? { "x-feature-slug": params.featureSlug } : {}),
    },
    body: JSON.stringify({
      parentRunId: params.parentRunId,
      orgId: params.orgId,
      userId: params.userId,
      service: params.service,
      featureSlug: params.featureSlug,
    }),
  });

  if (!res.ok) {
    throw new Error(`Failed to create run: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as { runId: string };
  return data.runId;
};
