import { env } from "../env";

const headers = () => ({
  "Content-Type": "application/json",
  "x-api-key": env.KEY_SERVICE_API_KEY,
});

export const storeRefreshToken = async (
  appId: string,
  accountId: string,
  refreshToken: string
): Promise<void> => {
  const provider = `google-ads-refresh-${accountId}`;
  const res = await fetch(`${env.KEY_SERVICE_URL}/internal/app-keys`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ appId, provider, apiKey: refreshToken }),
  });
  if (!res.ok) {
    throw new Error(`Failed to store refresh token: ${res.status} ${await res.text()}`);
  }
};

export const getRefreshToken = async (
  appId: string,
  accountId: string
): Promise<string> => {
  const provider = `google-ads-refresh-${accountId}`;
  const res = await fetch(
    `${env.KEY_SERVICE_URL}/internal/app-keys/${provider}/decrypt?appId=${encodeURIComponent(appId)}`,
    { headers: headers() }
  );
  if (!res.ok) {
    throw new Error(`Failed to get refresh token: ${res.status}`);
  }
  const data = (await res.json()) as { key: string };
  return data.key;
};
