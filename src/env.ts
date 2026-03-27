import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().default(8080),
  GOOGLE_SERVICE_DATABASE_URL: z.string().min(1),
  KEY_SERVICE_URL: z.string().url(),
  KEY_SERVICE_API_KEY: z.string().min(1),
  RUNS_SERVICE_URL: z.string().url(),
  RUNS_SERVICE_API_KEY: z.string().min(1),
  BILLING_SERVICE_URL: z.string().url(),
  BILLING_SERVICE_API_KEY: z.string().min(1),
});

export type Env = z.infer<typeof envSchema>;

export const env = envSchema.parse(process.env);
