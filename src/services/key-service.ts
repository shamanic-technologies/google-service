import { env } from "../env";

export interface CallerContext {
  method: string;
  path: string;
}

const headers = () => ({
  "Content-Type": "application/json",
  "x-api-key": env.KEY_SERVICE_API_KEY,
});

export const storeRefreshToken = async (
  orgId: string,
  accountId: string,
  refreshToken: string
): Promise<void> => {
  const provider = `google-ads-refresh-${accountId}`;
  const res = await fetch(`${env.KEY_SERVICE_URL}/internal/keys`, {
    method: "POST",
    headers: headers(),
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
  caller: CallerContext
): Promise<string> => {
  const provider = `google-ads-refresh-${accountId}`;
  const res = await fetch(
    `${env.KEY_SERVICE_URL}/keys/${provider}/decrypt?orgId=${encodeURIComponent(orgId)}&userId=${encodeURIComponent(userId)}`,
    {
      headers: {
        ...headers(),
        "X-Caller-Service": "google",
        "X-Caller-Method": caller.method,
        "X-Caller-Path": caller.path,
      },
    }
  );
  if (!res.ok) {
    throw new Error(`Failed to get refresh token: ${res.status}`);
  }
  const data = (await res.json()) as { key: string; keySource: string };
  return data.key;
};
