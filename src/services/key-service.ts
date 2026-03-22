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
  runId?: string
): Promise<string> => {
  const res = await fetch(
    `${env.KEY_SERVICE_URL}/keys/platform/${provider}/decrypt`,
    {
      headers: {
        ...headers(),
        "X-Caller-Service": "google",
        "X-Caller-Method": caller.method,
        "X-Caller-Path": caller.path,
        ...(runId ? { "x-run-id": runId } : {}),
      },
    }
  );
  if (!res.ok) {
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
  runId?: string
): Promise<GoogleCredentials> => {
  const [clientId, clientSecret, developerToken, mccAccountId] = await Promise.all([
    getPlatformKey("google-client-id", caller, runId),
    getPlatformKey("google-client-secret", caller, runId),
    getPlatformKey("google-developer-token", caller, runId),
    getPlatformKey("google-mcc-account-id", caller, runId),
  ]);
  return { clientId, clientSecret, developerToken, mccAccountId };
};

export const storeRefreshToken = async (
  orgId: string,
  accountId: string,
  refreshToken: string,
  runId?: string
): Promise<void> => {
  const provider = `google-ads-refresh-${accountId}`;
  const res = await fetch(`${env.KEY_SERVICE_URL}/internal/keys`, {
    method: "POST",
    headers: {
      ...headers(),
      ...(runId ? { "x-run-id": runId } : {}),
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
  runId?: string
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
  runId?: string
): Promise<string> => {
  const provider = "serper-dev";
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
      },
    }
  );
  if (!res.ok) {
    throw new Error(`Failed to get Serper API key: ${res.status}`);
  }
  const data = (await res.json()) as { key: string; keySource: string };
  return data.key;
};
