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
  featureSlug?: string,
  brandId?: string
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
        ...(brandId ? { "x-brand-id": brandId } : {}),
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
  featureSlug?: string,
  brandId?: string
): Promise<GoogleCredentials> => {
  const [clientId, clientSecret, developerToken, mccAccountId] = await Promise.all([
    getPlatformKey("google-client-id", caller, runId, featureSlug, brandId),
    getPlatformKey("google-client-secret", caller, runId, featureSlug, brandId),
    getPlatformKey("google-developer-token", caller, runId, featureSlug, brandId),
    getPlatformKey("google-mcc-account-id", caller, runId, featureSlug, brandId),
  ]);
  return { clientId, clientSecret, developerToken, mccAccountId };
};

export const storeRefreshToken = async (
  orgId: string,
  accountId: string,
  refreshToken: string,
  runId?: string,
  featureSlug?: string,
  brandId?: string
): Promise<void> => {
  const provider = `google-ads-refresh-${accountId}`;
  const res = await fetch(`${env.KEY_SERVICE_URL}/internal/keys`, {
    method: "POST",
    headers: {
      ...headers(),
      ...(runId ? { "x-run-id": runId } : {}),
      ...(featureSlug ? { "x-feature-slug": featureSlug } : {}),
      ...(brandId ? { "x-brand-id": brandId } : {}),
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
  featureSlug?: string,
  brandId?: string
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
        ...(brandId ? { "x-brand-id": brandId } : {}),
      },
    }
  );
  if (!res.ok) {
    throw new Error(`Failed to get refresh token: ${res.status}`);
  }
  const data = (await res.json()) as { key: string; keySource: string };
  return data.key;
};

export interface SerperKeyResult {
  key: string;
  keySource: "app" | "byok";
}

export const getSerperApiKey = async (
  orgId: string,
  userId: string,
  caller: CallerContext,
  runId?: string,
  featureSlug?: string,
  brandId?: string
): Promise<SerperKeyResult> => {
  const provider = "serper-dev";
  console.log(`[google-service] Resolving Serper key via auto-resolve: orgId=${orgId}`);
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
        ...(brandId ? { "x-brand-id": brandId } : {}),
      },
    }
  );
  if (!res.ok) {
    const body = await res.text();
    console.error(`[google-service] Failed to get Serper API key: ${res.status} body=${body}`);
    throw new Error(`Failed to get Serper API key: ${res.status}`);
  }
  const data = (await res.json()) as { key: string; keySource: string };
  console.log(`[google-service] Serper key resolved: keySource=${data.keySource}`);
  return { key: data.key, keySource: data.keySource as "app" | "byok" };
};
