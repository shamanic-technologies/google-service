import { z } from "zod";

const bootEnvSchema = z.object({
  KEY_SERVICE_URL: z.string().url(),
  KEY_SERVICE_API_KEY: z.string().min(1),
  GOOGLE_OAUTH_CLIENT_ID: z.string().min(1),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().min(1),
});

export const PROVIDER_CLIENT_ID = "google-oauth-client-id";
export const PROVIDER_CLIENT_SECRET = "google-oauth-client-secret";

const registerPlatformKey = async (
  baseUrl: string,
  serviceKey: string,
  provider: string,
  apiKey: string
): Promise<void> => {
  const res = await fetch(`${baseUrl}/platform-keys`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": serviceKey,
    },
    body: JSON.stringify({ provider, apiKey }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Failed to register platform key ${provider}: ${res.status} ${body}`
    );
  }
  console.log(`[google-service] Registered platform key ${provider}`);
};

export const instrument = async (): Promise<void> => {
  const boot = bootEnvSchema.parse(process.env);

  await Promise.all([
    registerPlatformKey(
      boot.KEY_SERVICE_URL,
      boot.KEY_SERVICE_API_KEY,
      PROVIDER_CLIENT_ID,
      boot.GOOGLE_OAUTH_CLIENT_ID
    ),
    registerPlatformKey(
      boot.KEY_SERVICE_URL,
      boot.KEY_SERVICE_API_KEY,
      PROVIDER_CLIENT_SECRET,
      boot.GOOGLE_OAUTH_CLIENT_SECRET
    ),
  ]);
};
