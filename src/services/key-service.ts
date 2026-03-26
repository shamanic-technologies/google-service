import { env } from "../env";

export interface CallerContext {
  method: string;
  path: string;
}

const headers = () => ({
  "Content-Type": "application/json",
  "x-api-key": env.KEY_SERVICE_API_KEY,
});

export const getPlatformKey = async (
  provider: string,
  caller: CallerContext,
  runId?: string,
  featureSlug?: string
): Promise<string> => {
  console.log(`[google-service] Resolving platform key: provider=${provider}`);
  const res = await fetch(
    `${env.KEY_SERVICE_URL}/keys/platform/${provider}/decrypt`,
    {
      headers: {
        ...headers(),
        "X-Caller-Service": "google",
        "X-Caller-Method": caller.method,
        "X-Caller-Path": caller.path,
        ...(runId ? { "x-run-id": runId } : {}),
        ...(featureSlug ? { "x-feature-slug": featureSlug } : {}),
      },
    }
  );
  if (!res.ok) {
    console.error(`[google-service] Failed to get platform key ${provider}: ${res.status}`);
    throw new Error(`Failed to get platform key ${provider}: ${res.status}`);
  }
  const data = (await res.json()) as { key: string };
  return data.key;
};

export interface GoogleCredentials {
  clientId: string;
  clientSecret: string;
  developerToken: string;
  mccAccountId: string;
}

export const getGoogleCredentials = async (
  caller: CallerContext,
  runId?: string,
  featureSlug?: string
): Promise<GoogleCredentials> => {
  const [clientId, clientSecret, developerToken, mccAccountId] = await Promise.all([
    getPlatformKey("google-client-id", caller, runId, featureSlug),
    getPlatformKey("google-client-secret", caller, runId, featureSlug),
    getPlatformKey("google-developer-token", caller, runId, featureSlug),
    getPlatformKey("google-mcc-account-id", caller, runId, featureSlug),
  ]);
  return { clientId, clientSecret, developerToken, mccAccountId };
};

export const storeRefreshToken = async (
  orgId: string,
  accountId: string,
  refreshToken: string,
  runId?: string,
  featureSlug?: string
): Promise<void> => {
  const provider = `google-ads-refresh-${accountId}`;
  const res = await fetch(`${env.KEY_SERVICE_URL}/internal/keys`, {
    method: "POST",
    headers: {
      ...headers(),
      ...(runId ? { "x-run-id": runId } : {}),
      ...(featureSlug ? { "x-feature-slug": featureSlug } : {}),
    },
    body: JSON.stringify({ orgId, provider, apiKey: refreshToken }),
  });
  if (!res.ok) {
    throw new Error(`Failed to store refresh token: ${res.status} ${await res.text()}`);
  }
};

export const getRefreshToken = async (
  orgId: string,
  userId: string,
  accountId: string,
  caller: CallerContext,
  runId?: string,
  featureSlug?: string
): Promise<string> => {
  const provider = `google-ads-refresh-${accountId}`;
  const res = await fetch(
    `${env.KEY_SERVICE_URL}/keys/${provider}/decrypt`,
    {
      headers: {
        ...headers(),
        "x-org-id": orgId,
        "x-user-id": userId,
        "X-Caller-Service": "google",
        "X-Caller-Method": caller.method,
        "X-Caller-Path": caller.path,
        ...(runId ? { "x-run-id": runId } : {}),
        ...(featureSlug ? { "x-feature-slug": featureSlug } : {}),
      },
    }
  );
  if (!res.ok) {
    throw new Error(`Failed to get refresh token: ${res.status}`);
  }
  const data = (await res.json()) as { key: string; keySource: string };
  return data.key;
};

export const getSerperApiKey = async (
  orgId: string,
  userId: string,
  caller: CallerContext,
  runId?: string,
  featureSlug?: string
): Promise<string> => {
  const provider = "serper-dev";
  console.log(`[google-service] Resolving Serper key: orgId=${orgId}`);
  const res = await fetch(
    `${env.KEY_SERVICE_URL}/keys/${provider}/decrypt`,
    {
      headers: {
        ...headers(),
        "x-org-id": orgId,
        "x-user-id": userId,
        "X-Caller-Service": "google",
        "X-Caller-Method": caller.method,
        "X-Caller-Path": caller.path,
        ...(runId ? { "x-run-id": runId } : {}),
        ...(featureSlug ? { "x-feature-slug": featureSlug } : {}),
      },
    }
  );
  if (!res.ok) {
    console.error(`[google-service] Failed to get Serper API key: ${res.status}`);
    throw new Error(`Failed to get Serper API key: ${res.status}`);
  }
  const data = (await res.json()) as { key: string; keySource: string };
  return data.key;
};
