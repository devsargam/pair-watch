import { err, ok, type Result } from "neverthrow";
import { z } from "zod";

const EnvSchema = z
  .object({
    R2_ACCESS_KEY_ID: z.string().min(1),
    R2_SECRET_ACCESS_KEY: z.string().min(1),
    R2_ENDPOINT: z.string().url(),
    R2_BUCKET: z.string().min(1),
    QUEUE_BACKEND_URL: z.string().url(),
    QUEUE_BACKEND_TOKEN: z.string().min(1).optional(),
    VPS_HLS_PREFIX: z.string().min(1).optional(),
    VPS_WORK_DIR: z.string().min(1).optional(),
  })
  .passthrough();

export type VpsEnv = {
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
  bucket: string;
  queueBackendUrl: string;
  queueBackendToken?: string;
  hlsPrefix: string;
  workDir: string;
};

export function loadEnv(): Result<VpsEnv, Error> {
  const parsed = EnvSchema.safeParse(Bun.env);
  if (!parsed.success) {
    return err(new Error(parsed.error.message));
  }

  const env = parsed.data;
  return ok({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    endpoint: env.R2_ENDPOINT,
    bucket: env.R2_BUCKET,
    queueBackendUrl: env.QUEUE_BACKEND_URL,
    queueBackendToken: env.QUEUE_BACKEND_TOKEN,
    hlsPrefix: env.VPS_HLS_PREFIX ?? "hls",
    workDir: env.VPS_WORK_DIR ?? "vps/work",
  });
}
