import { env } from "./env";

export const registerWithServices = async () => {
  // Register OAuth secrets with key-service
  await registerSecrets();
};

const registerSecrets = async () => {
  const secrets = [
    { provider: "google-client-id", apiKey: env.GOOGLE_CLIENT_ID },
    { provider: "google-client-secret", apiKey: env.GOOGLE_CLIENT_SECRET },
    { provider: "google-developer-token", apiKey: env.GOOGLE_DEVELOPER_TOKEN },
  ];

  for (const secret of secrets) {
    try {
      const res = await fetch(`${env.KEY_SERVICE_URL}/internal/platform-keys`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.KEY_SERVICE_API_KEY,
        },
        body: JSON.stringify({
          provider: secret.provider,
          apiKey: secret.apiKey,
        }),
      });

      if (!res.ok) {
        console.warn(`Failed to register secret ${secret.provider}: ${res.status}`);
      } else {
        console.log(`Registered secret: ${secret.provider}`);
      }
    } catch (err) {
      console.warn(`Failed to register secret ${secret.provider}:`, err);
    }
  }
};