import { err, ok, type Result } from "neverthrow";
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

export function loadEnv(): Result<UploaderEnv, Error> {
  const parsed = EnvSchema.safeParse(Bun.env);
  if (!parsed.success) {
    return err(new Error(parsed.error.message));
  }

  const env = parsed.data;

  const accessKeyId = env.R2_ACCESS_KEY_ID;
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY;
  const endpoint = env.R2_ENDPOINT;
  const bucket = env.R2_BUCKET;

  const prefix = (env.R2_PREFIX ?? "").replace(/^\/+|\/+$/g, "");
  const concurrency = Number.parseInt(env.R2_CONCURRENCY ?? "6", 10) || 6;

  return ok({
    accessKeyId,
    secretAccessKey,
    endpoint,
    bucket,
    prefix,
    concurrency,
  });
}
