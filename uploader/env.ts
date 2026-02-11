import { z } from "zod";

const EnvSchema = z
  .object({
    R2_ACCESS_KEY_ID: z.string().min(1),
    R2_SECRET_ACCESS_KEY: z.string().min(1),
    R2_ENDPOINT: z.string().url(),
    R2_BUCKET: z.string().min(1),
    R2_PREFIX: z.string().optional(),
    R2_CONCURRENCY: z
      .string()
      .regex(/^\d+$/)
      .optional(),
  })
  .passthrough();

export type UploaderEnv = {
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
  bucket: string;
  prefix: string;
  concurrency: number;
};

export function loadEnv(): UploaderEnv {
  let env: z.infer<typeof EnvSchema>;
  try {
    env = EnvSchema.parse(Bun.env);
  } catch (error) {
    console.error("Invalid environment variables.");
    console.error(error);
    process.exit(1);
  }

  const accessKeyId = env.R2_ACCESS_KEY_ID;
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY;
  const endpoint = env.R2_ENDPOINT;
  const bucket = env.R2_BUCKET;

  const prefix = (env.R2_PREFIX ?? "").replace(/^\/+|\/+$/g, "");
  const concurrency = Number.parseInt(env.R2_CONCURRENCY ?? "6", 10) || 6;

  return {
    accessKeyId,
    secretAccessKey,
    endpoint,
    bucket,
    prefix,
    concurrency,
  };
}
