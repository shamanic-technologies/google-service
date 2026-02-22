import { createApp } from "./app";
import { env } from "./env";
import { registerWithServices } from "./instrumentation";

const app = createApp();

app.listen(env.PORT, () => {
  console.log(`google-service listening on port ${env.PORT}`);
  registerWithServices().catch((err) =>
    console.error("Failed to register with services:", err)
  );
});
