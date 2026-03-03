import { env } from "./env";

export const registerWithServices = async () => {
  // Register OAuth secrets with key-service
  await registerSecrets();

  // Register with API Registry
  await registerWithApiRegistry();
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

const registerWithApiRegistry = async () => {
  try {
    const serviceUrl = process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : `http://localhost:${env.PORT}`;

    const res = await fetch(`${env.API_REGISTRY_URL}/services`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.API_REGISTRY_API_KEY,
      },
      body: JSON.stringify({
        name: "google",
        baseUrl: serviceUrl,
        openapiUrl: `${serviceUrl}/openapi.json`,
      }),
    });

    if (!res.ok) {
      console.warn(`Failed to register with API Registry: ${res.status}`);
    } else {
      console.log("Registered with API Registry");
    }
  } catch (err) {
    console.warn("Failed to register with API Registry:", err);
  }
};
