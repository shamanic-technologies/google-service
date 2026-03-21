import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().default(8080),
  DATABASE_URL: z.string().min(1),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GOOGLE_DEVELOPER_TOKEN: z.string().min(1),
  GOOGLE_MCC_ACCOUNT_ID: z.string().min(1),
  KEY_SERVICE_URL: z.string().url(),
  KEY_SERVICE_API_KEY: z.string().min(1),
  API_REGISTRY_URL: z.string().url(),
  API_REGISTRY_API_KEY: z.string().min(1),
  RUNS_SERVICE_URL: z.string().url(),
  RUNS_SERVICE_API_KEY: z.string().min(1),
  SERPER_API_KEY: z.string().min(1),
});

export type Env = z.infer<typeof envSchema>;

export const env = envSchema.parse(process.env);
